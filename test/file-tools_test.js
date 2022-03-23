const crypto = require('crypto')
const path = require('path')
const util = require('util')
const promisify = util.promisify || require('../simple-promisify')

const expect = require('chai').expect
const fs = require('graceful-fs')
const mkdirp = require('mkdirp')
const rimraf = require('rimraf')

const fileTools = require('../file-tools')

const ASSETS_BASE = path.resolve('./test/assets')
const assets = {
  srcDir: path.join(ASSETS_BASE, 'tempSrc'),
  destDir: path.join(ASSETS_BASE, 'tempDest'),
  srcName1: 'tempFile.bin',
  srcName2: 'bigTempFile.bin'
}
const smallFilePath = path.resolve(assets.srcDir, assets.srcName1)
const bigFilePath = path.resolve(assets.srcDir, assets.srcName2)
const notStringArgs = [ 42, true, {}, [] ]

function makeCleanDir(dirPath, next, finish) {
  rimraf(dirPath, function(rmrfErr) {
    if (rmrfErr) return finish(rmrfErr)
    mkdirp(dirPath, function(mkdirpErr) {
      if (mkdirpErr) return finish(mkdirpErr)
      next()
    })
  })
}

describe('file-tools submodule', function() {
  before('create temporary test assets', function(done) {
    makeCleanDir(assets.srcDir, makeDestinationDir, done)

    function makeDestinationDir() {
      makeCleanDir(assets.destDir, makeSrcFiles, done)
    }

    function makeSrcFiles() {
      const RANDOM_BYTE_COUNT = 256
      crypto.randomBytes(RANDOM_BYTE_COUNT, function(err, buf) {
        if (err) return done(err)
        fs.writeFile(smallFilePath, buf, function(err) {
          if (err) return done(err)
          // Fill a buffer that's bigger than the 64k highWaterMark
          const bigBuf = Buffer.alloc(65 * 1024, buf)
          fs.writeFile(bigFilePath, bigBuf, function(err) {
            return done(err)
          })
        })
      })
    }
  })

  after('remove temporary test assets', function(done) {
    rimraf(assets.srcDir, function(err) {
      if (err) return done(err)
      rimraf(assets.destDir, function(err) {
        return done(err)
      })
    })
  })

  it('should export functions copyFile and mv', function() {
    expect(fileTools.copyFile).to.be.a('function')
    expect(fileTools.mv).to.be.a('function')
  })

  const didNotError = new Error("There should have been an error")

  describe('copyFile()', function() {
    it('should reject if given no arguments', function(done) {
      fileTools.copyFile()
      .then(() => done(didNotError))
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject if given empty arguments or not enough arguments', function(done) {
      fileTools.copyFile(smallFilePath)
      .then(() => done(didNotError))
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        return fileTools.copyFile(smallFilePath, null)
        .then(() => done(didNotError))
      })
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        return fileTools.copyFile(undefined, assets.destDir)
        .then(() => done(didNotError))
      })
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        return fileTools.copyFile(null, assets.destDir)
        .then(() => done(didNotError))
      })
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject if given an empty string argument', function(done) {
      fileTools.copyFile(smallFilePath, '')
      .then(() => done(didNotError))
      .catch(err => {
        expect(err).to.be.an.instanceof(Error)
        return fileTools.copyFile('', assets.destDir)
        .then(() => done(didNotError))
      })
      .catch(err => {
        expect(err).to.be.an.instanceof(Error)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject if given a non-string argument', function(done) {
      function nextNonstring(i) {
        if (i >= notStringArgs.length) return done()
        return fileTools.copyFile(smallFilePath, notStringArgs[i])
        .then(() => done(didNotError))
        .catch(err => {
          expect(err).to.be.an.instanceof(TypeError)
          return fileTools.copyFile(notStringArgs[i], assets.destDir)
          .then(() => done(didNotError))
        })
        .catch(err => {
          expect(err).to.be.an.instanceof(TypeError)
          return nextNonstring(i+1)
        })
        .catch(err => done(err))
      }

      nextNonstring(0)
    })

    it('should reject if source does not exist', function(done) {
      const fakeSrc = path.join(assets.srcDir, 'NO_SUCH_FILE')
      fileTools.copyFile(fakeSrc, assets.destDir)
      .then(() => done(didNotError))
      .catch(err => done())
      // TODO maybe? check for specific error code
    })


// TODO: find out how to set up a test of this description on Windows!
    if (process.platform != 'win32')
      it('should reject if source is unreadable', function(done) {
        // 0o222: -w--w--w-
        fs.chmod(smallFilePath, 0o222, function(err) {
          if (err) return done(err)
          fileTools.copyFile(smallFilePath, assets.destDir)
          .then(() => cleanUpAndFinish(didNotError))
          .catch(err => cleanUpAndFinish())
        })
        function cleanUpAndFinish(err) {
          // 0o666: rw-rw-rw-
          fs.chmod(smallFilePath, 0o666, function(chmodErr) {
            return done(err || chmodErr)
          })
        }
      })

    it('should reject if destination path does not exist', function(done) {
      fileTools.copyFile(smallFilePath, path.join(ASSETS_BASE, 'NO_SUCH_DIR'))
      .then(() => done(didNotError))
      .catch(err => {
        fileTools.copyFile(bigFilePath, path.join(ASSETS_BASE, 'NO_SUCH_DIR'))
        .then(() => done(didNotError))
        .catch(err => done())
      })
    })

// TODO: find out how to set up a test of this description on Windows!
    if (process.platform != 'win32')
      it('should reject if destination path is unwritable', function(done) {
        // 0o555: r-xr-xr-x
        fs.chmod(assets.destDir, 0o555, function(err) {
          if (err) return done(err)
          fileTools.copyFile(smallFilePath, assets.destDir)
          .then(() => cleanUpAndFinish(didNotError))
          .catch(err => {
            fileTools.copyFile(bigFilePath, assets.destDir)
            .then(() => cleanUpAndFinish(didNotError))
            .catch(err => cleanUpAndFinish())
          })
        })
        function cleanUpAndFinish(err) {
          // 0o755: rwxr-xr-x
          fs.chmod(assets.destDir, 0o755, function(chmodErr) {
            return done(err || chmodErr)
          })
        }
      })

    it('should succeed for existing source file and favorable conditions', function(done) {
      const readFileAsync = promisify(fs.readFile)
      const filename = path.parse(bigFilePath).base
      const target = path.join(assets.destDir, filename)

      fileTools.copyFile(bigFilePath, assets.destDir)
      .then(() => readFileAsync(bigFilePath))
      .then(srcBuf => {
        return readFileAsync(target)
        .then(destBuf => {
          expect(destBuf.equals(srcBuf)).to.be.true
          done()
        })
      })
      .catch(err => done(err))
    })

    it('should reject if file already exists at destination', function(done) {
      fileTools.copyFile(bigFilePath, assets.destDir)
      .then(() => done(didNotError))
      .catch(err => {
        expect(err.code).to.equal('EEXIST')

        // The file is at destDir as a result of the previous test, not this one.
        // Now we remove it from destDir so the next tests have a fresh start.
        const filename = path.parse(bigFilePath).base
        const target = path.join(assets.destDir, filename)
        fs.unlink(target, function(err) { done(err) })
      })
      .catch(err => done(err))
    })

  })

  describe('mv()', function() {
    it('should reject if given no arguments', function(done) {
      fileTools.mv()
      .then(() => done(didNotError))
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject if not given enough arguments', function(done) {
      fileTools.mv(smallFilePath)
      .then(() => done(didNotError))
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        return fileTools.mv(smallFilePath, null)
        .then(() => done(didNotError))
      })
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        return fileTools.mv(undefined, assets.destDir)
        .then(() => done(didNotError))
      })
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        return fileTools.mv(null, assets.destDir)
        .then(() => done(didNotError))
      })
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject if given an empty string', function(done) {
      fileTools.mv(smallFilePath, '')
      .then(() => done(didNotError))
      .catch(err => {
        expect(err).to.be.an.instanceof(Error)
        return fileTools.mv('', assets.destDir)
        .then(() => done(didNotError))
      })
      .catch(err => {
        expect(err).to.be.an.instanceof(Error)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject if given a non-string argument', function(done) {
      function nextNonstring(i) {
        if (i >= notStringArgs.length) return done()
        return fileTools.mv(smallFilePath, notStringArgs[i])
        .then(() => done(didNotError))
        .catch(err => {
          expect(err).to.be.an.instanceof(TypeError)
          return fileTools.mv(notStringArgs[i], assets.destDir)
          .then(() => done(didNotError))
        })
        .catch(err => {
          expect(err).to.be.an.instanceof(TypeError)
          return nextNonstring(i+1)
        })
        .catch(err => done(err))
      }

      nextNonstring(0)
    })

    it('should reject if source does not exist', function(done) {
      const fakeSrc = path.join(assets.srcDir, 'NO_SUCH_FILE')
      fileTools.mv(fakeSrc, assets.destDir)
      .then(() => done(didNotError))
      .catch(err => done())
    })

    it('should reject if destination path does not exist', function(done) {
      fileTools.mv(smallFilePath, path.join(ASSETS_BASE, 'NO_SUCH_DIR'))
      .then(() => done(didNotError))
      .catch(err => {
        // TODO: expect an error code?
        fileTools.mv(bigFilePath, path.join(ASSETS_BASE, 'NO_SUCH_DIR'))
        .then(() => done(didNotError))
        .catch(err => done())
      })
    })

// TODO: find out how to set up a test of this description on Windows!
    if (process.platform != 'win32')
      it('should reject if destination path is unwritable', function(done) {
        function cleanUpAndFinish(err) {
          // 0o755: rwxr-xr-x
          fs.chmod(assets.destDir, 0o755, function(chmodErr) {
            return done(err || chmodErr)
          })
        }
        // 0o555: r-xr-xr-x
        fs.chmod(assets.destDir, 0o555, function(err) {
          if (err) return done(err)
          fileTools.mv(smallFilePath, assets.destDir)
          .then(() => cleanUpAndFinish(didNotError))
          .catch(err => {
            // TODO: expect an error code?
            fileTools.mv(bigFilePath, assets.destDir)
            .then(() => cleanUpAndFinish(didNotError))
            .catch(err => cleanUpAndFinish())
          })
        })
      })

    function putBack(target, oldFilepath, cb) {
      fs.link(target, oldFilepath, function(err) {
        if (err) return cb(err)
        fs.unlink(target, cb)
      })
    }

    it('should reject if location of source is unchangeable', function(done) {
      // 0o555: r-xr-xr-x
      fs.chmod(assets.srcDir, 0o555, function(err) {
        if (err) return done(err)
        fileTools.mv(smallFilePath, assets.destDir)
        .then(() => cleanUpAndFinish(didNotError))
        .catch(err => cleanUpAndFinish())
      })
      function cleanUpAndFinish(err) {
        // 0o755: rwxr-xr-x
        fs.chmod(assets.srcDir, 0o755, function(chmodErr) {
          if (!err) return done(chmodErr)
          const target = path.join(assets.destDir, assets.srcName1)
          putBack(target, smallFilePath, function(putBackErr) {
            done(putBackErr)
          })
        })
      }
    })

    it('should succeed for existing source file and favorable conditions', function(done) {
      fileTools.mv(smallFilePath, assets.destDir)
      .then(() => {
        // Clean up and finish
        const target = path.join(assets.destDir, assets.srcName1)
        putBack(target, smallFilePath, function(putBackErr) {
          done(putBackErr)
        })
      })
      .catch(err => done(err))
    })

    /*
      Note the difference between this and the corresponding copyFile case.
      mv() uses fs.link() if the destination is on the same device, which is
      all we can do here (where we don't know anything about whatever other
      devices may be available on an arbitrary platform); however, if the
      destination is on another device, the operation ultimately uses
      copyFile(), in which case this test would fail.
    */
    it('should succeed even if source is unreadable', function(done) {
      // 0o222: -w--w--w-
      fs.chmod(smallFilePath, 0o222, function(err) {
        if (err) return done(err)
        fileTools.mv(smallFilePath, assets.destDir)
        .then(() => cleanUpAndFinish())
        .catch(err => done(err))
      })
      function cleanUpAndFinish() {
        // 0o666: rw-rw-rw-
        const target = path.join(assets.destDir, assets.srcName1)
        fs.chmod(target, 0o666, function(chmodErr) {
          if (chmodErr) return done(chmodErr)
          putBack(target, smallFilePath, function(putBackErr) {
            done(putBackErr)
          })
        })
      }
    })

    it('should reject if source file already exists at destination', function(done) {
      // Rely on the putBack() of the previous test cleanup *and* the
      // already-tested correctness of copyFile...
      fileTools.copyFile(smallFilePath, assets.destDir)
      .then(() => {
        fileTools.mv(smallFilePath, assets.destDir)
        .then(() => done(didNotError))
        .catch(err => {
          expect(err.code).to.equal('EEXIST')
          done()
        })
      })
      .catch(err => done(err))
    })

  })
})

