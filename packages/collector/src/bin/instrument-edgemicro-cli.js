#!/usr/bin/env node

/* eslint-disable no-console */

'use strict';

// The purpose of this executable is to statically instrument a _global_ installation of Apigee's edgemicro/Microgateway
// package (https://www.npmjs.com/package/edgemicro). In its default installation scenario (that is advertised in the
// basic tutorials, for example), the edgemicro npm module is installed globally via npm install -g edgemicro. To start
// the edgemicro Node.js process, the main executable of this globally installed package is used, like this:
// edgemicro start -o $org -e $env -k $key -s $secret
//
// Thus, there is no user controlled code when that Node.js process is starting up, and in turn our usual installation
// documented at https://docs.instana.io/ecosystem/node-js/installation/ can not be performed (in particular, there is
// no user controlled code to put the require('@instana/collector')(); into.
//
// The purpose of this executable is to fill this gap. It needs to be called after the edgemicro package has been
// installed. The package @instana/collector also needs to be installed. This executable will statically instrument the
// edgemicro main CLI source file and put the require('@instana/collector')(); into the right place. Naturally, this
// needs to be repeated after an update/reinstallation of the edgemicro package.
//
// This executable is not needed for installation scenarios where user code is started first that then requires for
// example microgateway-core (https://github.com/apigee/microgateway-core).
//
// Why don't we simply add our require-and-init via an edgemicro plug-in? Because the plug-in code is evaluated too
// late, after the workers have been already started. Thus, the instrumentation in
// core/src/tracing/process/edgemicro.js and core/src/tracing/process/childProcess isn't active when workers are
// started. The plug-in code would also be evaluated in each worker process, but again, too late, that is tracing would
// only work partially.

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

var selfPath = require('./selfPath');

var edgemicroCliMain = 'cli/edgemicro';

module.exports = exports = function instrumentEdgemicroCli(edgemicroPath, collectorPath, callback) {
  if (typeof edgemicroPath === 'function') {
    callback = edgemicroPath;
    edgemicroPath = undefined;
    collectorPath = undefined;
  }
  if (typeof collectorPath === 'function') {
    callback = collectorPath;
    collectorPath = undefined;
  }

  if (!callback) {
    throw new Error('Mandatory argument callback is missing.');
  }
  if (typeof callback !== 'function') {
    throw new Error('The callback argument is not a function but of type ' + typeof callback + '.');
  }

  if (!edgemicroPath) {
    console.log('- Path to edgemicro has not been provided, I will try to figure it out now.');
    var globalNodeModules = childProcess
      .execSync('npm root -g')
      .toString()
      .trim();
    console.log('    * Global node_modules directory:', globalNodeModules);
    edgemicroPath = path.join(globalNodeModules, 'edgemicro');
    if (!fs.existsSync(edgemicroPath)) {
      return callback(
        new Error(
          'It seems there is no edgemicro installation at ' +
            edgemicroPath +
            '. You can also provide the path to your edgemicro installation explicitly as a command line argument.'
        )
      );
    }
    console.log('    * Global edgemicro installation should be in:', edgemicroPath);
    console.log('- Path to edgemicro has not been provided, I will assume it is:', edgemicroPath);
  }
  if (typeof edgemicroPath !== 'string') {
    return callback(
      new Error('The path to edgemicro needs to be a string but was of type ' + typeof edgemicroPath) + '.'
    );
  }

  if (!collectorPath) {
    collectorPath = selfPath.collectorPath;
    console.log('- Path to @instana/collector has not been provided, I will assume it is:', collectorPath);
  }
  if (typeof collectorPath !== 'string') {
    return callback(
      new Error('The path to @instana/collector needs to be a string but was of type ' + typeof collectorPath + '.')
    );
  }

  console.log('- Provided arguments:');
  console.log('    * Path to the edgemicro package:', edgemicroPath);
  if (!path.isAbsolute(edgemicroPath)) {
    edgemicroPath = path.resolve(edgemicroPath);
    console.log('    * resolved absolute path for edgemicro package:', edgemicroPath);
  }
  console.log('    * Path to the @instana/collector:', collectorPath);
  if (!path.isAbsolute(collectorPath)) {
    collectorPath = path.resolve(collectorPath);
    console.log('    * resolved absolute path for @instana/collector:', collectorPath);
  }

  console.log('- Checking if @instana/collector exists at ' + collectorPath + '.');
  fs.access(collectorPath, fs.constants.F_OK, function(fsAccessError) {
    if (fsAccessError) {
      console.log(fsAccessError);
      return callback(fsAccessError);
    }

    try {
      var collectorPackageJson = require(path.join(collectorPath, 'package.json'));
      if (collectorPackageJson.name !== '@instana/collector') {
        return callback(
          new Error(
            'The provided path for @instana/collector does not seem to be valid, expected the package name to be ' +
              '@instana/collector, instead the name "' +
              collectorPackageJson.name +
              '" has been found.'
          )
        );
      }
    } catch (packageJsonError) {
      return callback(
        new Error(
          'The provided path for @instana/collector does not seem to be valid, there is no package.json at the ' +
            'expected location or it cannot be parsed: ' +
            packageJsonError.stack
        )
      );
    }

    var edgemicroCliMainFullPath = path.resolve(edgemicroPath, edgemicroCliMain);
    console.log('- Will instrument the following file:', edgemicroCliMainFullPath);

    createBackupAndInstrument(edgemicroCliMainFullPath, collectorPath, callback);
  });
};

function createBackupAndInstrument(edgemicroCliMainFullPath, collectorPath, callback) {
  var backupFullPath = edgemicroCliMainFullPath + '.backup';
  console.log('- Creating a backup at:', backupFullPath);
  copyFile(edgemicroCliMainFullPath, backupFullPath, function(copyErr) {
    if (copyErr) {
      console.error(copyErr);
      return callback(copyErr);
    }
    instrument(edgemicroCliMainFullPath, collectorPath, callback);
  });
}

function copyFile(source, target, copyCallback) {
  var callbackHasBeenCalled = false;
  var readStream = fs.createReadStream(source);
  var writeBackupStream = fs.createWriteStream(target);
  readStream.on('error', function(err) {
    if (!callbackHasBeenCalled) {
      callbackHasBeenCalled = true;
      copyCallback(err);
    }
  });
  writeBackupStream.on('error', function(err) {
    if (!callbackHasBeenCalled) {
      callbackHasBeenCalled = true;
      copyCallback(err);
    }
  });
  writeBackupStream.on('finish', function() {
    if (!callbackHasBeenCalled) {
      callbackHasBeenCalled = true;
      copyCallback();
    }
  });
  readStream.pipe(writeBackupStream);
}

function instrument(fileToBeInstrumented, collectorPath, callback) {
  console.log('- Reading:', fileToBeInstrumented);
  fs.readFile(fileToBeInstrumented, 'utf8', function(readErr, content) {
    if (readErr) {
      console.error(readErr);
      return callback(readErr);
    }

    var result;

    var match = /\nrequire[^\n]*collector[^\n]*\n/.exec(content);
    if (match) {
      result =
        content.substring(0, match.index + 1) +
        "require('" +
        collectorPath +
        "')();\n" +
        content.substring(match.index + match[0].length);
    } else {
      result = content.replace(/\n'use strict';\n/, "\n'use strict';\nrequire('" + collectorPath + "')();\n");
    }

    console.log('- Writing:', fileToBeInstrumented);
    fs.writeFile(fileToBeInstrumented, result, 'utf8', function(writeErr) {
      if (writeErr) {
        console.error(writeErr);
        return callback(writeErr);
      }

      callback();
    });
  });
}

if (require.main === module) {
  // The file is running as a script, kick off the instrumentation directly.
  module.exports(process.argv[2], process.argv[3], function(err) {
    if (err) {
      console.error('Failed to instrument the edgemicro module', err);
      process.exit(1);
    }
    console.log(
      '- Done: The edgemicro module has been statically instrumented for Instana tracing and metrics collection.'
    );
  });
} else {
  // Not running as a script, wait for client code to trigger the instrumentation.
  console.warn(
    'The file ' +
      path.join(__dirname, 'instrument-edgemicro-cli.js') +
      ' has been required by another module instead of being run directly as a script. ' +
      'You need to call the exported function yourself to start the instrumentation in this scenario.'
  );
}
