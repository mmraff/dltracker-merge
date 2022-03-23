const path = require('path')
const fs = require('graceful-fs')
const DEBUG = false

const log = DEBUG ? {
  error: function(func, msg) { console.error("ERR! %s: %s", func, msg) },
  info: function(func, msg) { console.log("INFO %s: %s", func, msg) }
} : {
  error: function() {},
  info: function() {}
}

function expectNonemptyString(arg, name) {
  if (arg === undefined || arg === null)
    throw new SyntaxError(`No ${name} argument given`)
  if (typeof arg != 'string')
    throw new TypeError(`${name} argument must be a string`)
  if (!arg.length)
    throw new Error(`${name} argument must not be empty`)
}

function closeStream(str, cb) {
  if (typeof str.destroy == 'function') { // Added in node.js v8.0.0
    str.destroy()
    return cb()
  }
  // else
  fs.close(str.fd, function(closeErr) { cb(closeErr) })
}

/*
 A simplified implementation of cp
 * assume src to be a file; if not, just error out
 * assume dest to be an existing directory; if not, just error out
 * if dest/srcFile already exists, error out
*/
function copyFile(src, dest) {
  try {
    expectNonemptyString(src, 'source')
    expectNonemptyString(dest, 'destination')
  }
  catch (err) { return Promise.reject(err) }

  let hadError = false
  let alreadyResolved = false
  return new Promise((resolve, reject) => {
    function errorOut(err) {
      if (!hadError && !alreadyResolved) {
        hadError = true
        reject(err)
      }
    }
    let destStream
    const filename = path.parse(src).base
    const srcStream = fs.createReadStream(src)
    srcStream.once('open', function(fd) {
      const target = path.join(dest, filename)
      const writeOpts = { flags: 'wx', encoding: null }
      destStream = fs.createWriteStream(target, writeOpts)
      destStream.once('error', function(err) {
        log.error('copyFile', 'writeStream error!')
        if (!srcStream._readableState.ended)
          closeStream(srcStream, function(closeErr) {
            if (closeErr)
              log.warn('copyFile', 'And then failed to close source stream!')
          })
        errorOut(err)
      })
      .once('close', function() {
        log.info('copyFile', 'destStream closed.')
      })
      .once('finish', function() {
        log.info('copyFile', 'Finished copying to ' + target)
        if (!hadError) {
          alreadyResolved = true
          resolve(target)
        }
      })
      srcStream.pipe(destStream)
    })
    .once('error', function(err) {
      log.error('copyFile', 'readStream error!')
      /*
      node.js API doc for readable stream method pipe() says
        "...if the Readable stream emits an error during processing, the
         Writable destination is not closed automatically. If an error occurs,
         it will be necessary to manually close each stream in order to prevent
         memory leaks."
      */
      if (destStream) destStream.end(function() {
        fs.unlink(target, function(rmErr) {
          // TODO: is it worth doing anything with rmErr?
        })
      })
      errorOut(err)
    })
    .once('close', function() {
      log.info('copyFile', 'srcStream closed.')
    })
  })
}

function mvOnSameDevice(src, target, cb) {
  return new Promise((resolve, reject) => {
    fs.link(src, target, function(err) {
      if (err) return reject(err)
      fs.unlink(src, function(srcErr) {
        if (srcErr) {
          return fs.unlink(target, function(tgtErr) {
            return reject(srcErr)
          })
        }
        log.info('mvOnSameDevice', 'move accomplished')
        resolve(null)
      })
    })
  })
}

function mvToOtherDevice(src, dest) {
  return copyFile(src, dest)
  .then(destFile => {
    return new Promise((resolve, reject) => {
      fs.unlink(src, function(srcErr) {
        // Was the copy made from a read-only/protected location?
        if (srcErr) {
// The error code I get here (when testing with a file on a DVD) is 'EROFS', errno -30
          return fs.unlink(destFile, function(tgtErr) {
            return reject(srcErr)
          })
        }
        log.info('mvToOtherDevice', 'different-device MV accomplished')
        resolve(null)
      })
    })
  })
}

function mv(src, dest) {
  try {
    expectNonemptyString(src, 'source')
    expectNonemptyString(dest, 'destination')
  }
  catch (err) { return Promise.reject(err) }

  const filename = path.parse(src).base
  const target = path.join(dest, filename)
  return mvOnSameDevice(src, target)
  .catch(err => {
    if (err.code == 'EXDEV')
      return mvToOtherDevice(src, dest)
    throw err
  })
}

module.exports = {
  copyFile: copyFile,
  mv: mv
}

