const assert = require('assert')
const fs = require('fs')
const path = require('path')
const util = require('util')
const promisify = util.promisify || require('./simple-promisify')
const readdirAsync = promisify(fs.readdir)
const lstatAsync = promisify(fs.lstat)

const expect = require('chai').expect
const mkdirpAsync = promisify(require('mkdirp'))
const npf = require('npm-package-filename')
const rimrafAsync = promisify(require('rimraf'))
const tar = require('tar')
const createDlTracker = require('npm-package-dl-tracker').create
const createDlTrackerAsync = promisify(createDlTracker)

const mergeLib = require('../merge-lib')

const MAPFILE_NAME = 'dltracker.json'
const ASSETS_BASE = './test/assets' // TODO: is there a better way to spec this?
const TEMPDIR_BASE = path.join(ASSETS_BASE, 'temp')
const testDirs = [ 'tarballs', 'empty1', 'empty2', 'dir1', 'dir2', 'dir3' ]
const srcDir = path.join(ASSETS_BASE, 'temp', testDirs[0])
const origTarball = 'original.tgz'

function evalJsonFile(filepath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filepath, 'utf8', (err, txt) => {
      if (err) return reject(err)
      // Strip BOM, if any
      if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1)
      let data
      try { data = JSON.parse(txt) }
      catch (err) { return reject(err) }
      resolve(data)
    })
  })
}

function stripMetadata(trackerMap) {
  delete trackerMap.description
  delete trackerMap.version
  delete trackerMap.created
}

function extractFilenames(trackerMap) {
  const list = []
  const semverMap = trackerMap.semver || {}
  for (let name in semverMap) {
    const versions = semverMap[name]
    for (let ver in versions) {
      if ('filename' in versions[ver])
        list.push(versions[ver].filename)
    }
  }
  const gitMap = trackerMap.git || {}
  for (let repo in gitMap) {
    const refs = gitMap[repo]
    for (let ref in refs) {
      if ('filename' in refs[ref])
        list.push(refs[ref].filename)
    }
  }
  const urlMap = trackerMap.url || {}
  for (let spec in urlMap) {
    if ('filename' in urlMap[spec])
      list.push(urlMap[spec].filename)
  }
  return list
}

function recreateDir(dir) {
  return rimrafAsync(dir).then(() => mkdirpAsync(dir))
}

function copyFile(from, to) {
  return new Promise((resolve, reject) => {
    var hadError = false
    function errorOut(err) {
      hadError = true
      reject(err)
    }
    fs.createReadStream(from)
    .once('error', errorOut)
    .pipe(fs.createWriteStream(to, {encoding: null}))
    .once('error', errorOut)
    .once('close', function () {
      if (!hadError) resolve(null)
    })
  })
}

function mockAllDownloads(list, idx, where) {
  if (idx >= list.length) return Promise.resolve(null)
  const src = path.join(srcDir, origTarball)
  const target = path.join(where, list[idx])
  return copyFile(src, target)
  .then(() => mockAllDownloads(list, idx+1, where))
}

function configureTestDir(dir, jsonFile, recreate) {
  const srcPath = path.join(ASSETS_BASE, 'json', jsonFile)
  return Promise.resolve(recreate ? recreateDir(dir) : null)
  .then(() => evalJsonFile(srcPath))
  .then(pkgMap => {
    return Promise.resolve(extractFilenames(pkgMap))
    .then(fileList => mockAllDownloads(fileList, 0, dir))
    .then(() => copyFile(srcPath, path.join(dir, MAPFILE_NAME)))
    .then(() => pkgMap)
  })
}

// Takes a tracker map and a tracker, and expects every (properly augmented)
// record in the map to match the corresponding tracker.getData result.
function expectTrackerToHaveAll(tracker, map) {
  const semverMap = map.semver || {}
  for (let name in semverMap) {
    const versions = semverMap[name]
    for (let ver in versions) {
      const tgt = tracker.getData('semver', name, ver)
      const src = Object.assign({}, versions[ver])
      src.type = 'semver'
      src.name = name
      src.version = ver
      expect(tgt).to.deep.equal(src)
    }
  }
  const tagMap = map.tag || {}
  for (let name in tagMap) {
    const tags = tagMap[name]
    for (let tag in tags) {
      const tgt = tracker.getData('tag', name, tag)
      const src = Object.assign({}, tags[tag])
      Object.assign(src, semverMap[name][src.version])
      src.type = 'tag'
      src.name = name
      src.spec = tag
      expect(tgt).to.deep.equal(src)
    }
  }
  const gitMap = map.git || {}
  for (let repo in gitMap) {
    const commits = gitMap[repo]
    for (let cmt in commits) {
      const tgt = tracker.getData('git', repo, cmt)
      const src = Object.assign({}, commits[cmt])
      src.type = 'git'
      src.repo = repo
      if (src.commit) { // It's a git tag record
        Object.assign(src, commits[src.commit])
        src.spec = cmt
      }
      else src.commit = cmt
      expect(tgt).to.deep.equal(src)
    }
  }
  const urlMap = map.url || {}
  for (let spec in urlMap) {
    const tgt = tracker.getData('url', null, spec)
    const src = Object.assign({}, urlMap[spec])
    src.type = 'url'
    src.spec = spec
    expect(tgt).to.deep.equal(src)
  }
}

function expectErrorFreeAudit(dlDir) {
  return createDlTrackerAsync(dlDir)
  .then(tracker => {
    return promisify(tracker.audit)()
    .then(list => {
      if (list.length)
        throw new Error("unexpected dltracker audit errors")
      else return tracker
    })
  })
}

function expectCopiesOfTarballs(srcPath, tgtPath) {
  return readdirAsync(srcPath).then(srcList => {
    function nextFile(i) {
      if (i >= srcList.length) return Promise.resolve(null)
      const filename = srcList[i]
      if (!npf.hasTarballExtension(filename)) return nextFile(i+1)
      const srcFilePath = path.join(srcPath, filename)
      const tgtFilePath = path.join(tgtPath, filename)
      return lstatAsync(srcFilePath).then(srcStats => {
        return lstatAsync(tgtFilePath).then(tgtStats => {
          expect(tgtStats.size).to.equal(srcStats.size)
          return nextFile(i+1)
        })
      })
    }
    return nextFile(0)
  })
}

function expectCopiesOfTarballs2(srcList, tgtPath) {
  function nextFile(i) {
    if (i >= srcList.length) return Promise.resolve(null)
    const filename = srcList[i].filename
    const srcStats = srcList[i].stats
    const tgtFilePath = path.join(tgtPath, filename)
    return lstatAsync(tgtFilePath).then(tgtStats => {
      expect(tgtStats.size).to.equal(srcStats.size)
      return nextFile(i+1)
    })
  }
  return nextFile(0)
}

function getDirContentData(dir) {
  const data = []
  return readdirAsync(dir).then(list => {
    function nextFile(i) {
      if (i >= list.length) return Promise.resolve(data)
      const filename = list[i]
      if (!npf.hasTarballExtension(filename)) return nextFile(i+1)
      const filepath = path.join(dir, filename)
      return lstatAsync(filepath).then(stats => {
        data.push({ filename: filename, stats: stats })
        return nextFile(i+1)
      })
    }
    return nextFile(0)
  })
}

let nonexistentDirCount = 0
function nextNoSuchDirName() {
  return 'noSuchDir' + ++nonexistentDirCount
}

describe('dltracker-merge library module', function() {
  const fileList1 = []

  before('make clean directories and generate source tarballs', function(done) {
    const dummyContentPath = path.join(ASSETS_BASE, 'package')
    const tarball1Path = path.join(srcDir, origTarball)
    const allGoodJson = path.join(ASSETS_BASE, 'json', 'dltracker_ALL_GOOD.json')
  
    rimrafAsync(TEMPDIR_BASE)
    .then(() => mkdirpAsync(TEMPDIR_BASE))
    .then(() => nextTempDir(0))
    .then(() => {
      tar.c(
        { gzip: true, file: tarball1Path }, [ dummyContentPath ]
      )
      .then(() => evalJsonFile(allGoodJson))
      .then(map => extractFilenames(map))
      .then(list => {
        fileList1.splice(0, 0, ...list)
        return createOtherTarballs(0, list)
      })
      .catch(err => done(err))
    })
  
    function nextTempDir(i) {
      if (i >= testDirs.length) return Promise.resolve(null)
      const dirPath = path.join(TEMPDIR_BASE, testDirs[i])
      return mkdirpAsync(dirPath).then(() => nextTempDir(i+1))
    }

    // This fills srcDir with tarballs for every filename in filenames
    // (every one is just a copy of the first)
    function createOtherTarballs(idx, filenames) {
      if (idx >= filenames.length) return Promise.resolve(done())
      const tgtPath = path.join(srcDir, filenames[idx])
      return copyFile(tarball1Path, tgtPath)
      .then(() => createOtherTarballs(idx+1, filenames))
    }
  })

  after('remove temporary directories', function(done) {
    rimrafAsync(path.join(ASSETS_BASE, 'temp'))
    .then(() => done())
    .catch(err => done(err))
  })

  const notStrings = [ 42, true, {}, [] ]
  const notArrays  = [ 42, true, {}, 'example' ]
  const notSimpleObjects = [ 42, true, 'example', [], new Date() ]
  const didNotError = new Error('Expected rejection failed to happen')

  const emptyPath1 = path.join(TEMPDIR_BASE, 'empty1')
  const emptyPath2 = path.join(TEMPDIR_BASE, 'empty2')
  const path1 = path.join(TEMPDIR_BASE, 'dir1')
  const path2 = path.join(TEMPDIR_BASE, 'dir2')
  const path3 = path.join(TEMPDIR_BASE, 'dir3')

  describe('merge() misuse', function() {
    it('should reject when given nothing or null for 1st argument', function(done) {
      mergeLib.merge()
      .then(() => done(didNotError))
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)

        return mergeLib.merge(null)
        .then(() => done(didNotError))
        .catch(err => {
          expect(err).to.be.an.instanceof(SyntaxError)
          done()
        })
      })
      .catch(err => done(err)) // AssertionError from expect()
    })

    it('should reject when given 1st argument that is not an array', function(done) {
      function nextNonArray(i) {
        if (i >= notArrays.length) return Promise.resolve(done())
        mergeLib.merge(notArrays[i])
        .then(() => done(didNotError))
        .catch(err => {
          expect(err).to.be.an.instanceof(TypeError)
          return nextNonArray(++i)
        })
        .catch(err => done(err))
      }

      nextNonArray(0)
    })

    it('should reject when given an array of less than 2 items', function(done) {
      mergeLib.merge([])
      .then(() => done(didNotError))
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)

        return mergeLib.merge(['example-path'])
        .then(() => done(didNotError))
        .catch(err => {
          expect(err).to.be.an.instanceof(SyntaxError)
          done()
        })
      })
      .catch(err => done(err)) // AssertionError from failed expect()
    })

    it('should reject when given wrong type for any path', function(done) {
      const refArgs = ['path1', 'path2', 'path3']
      let argIdx = 0

      // Expect merge to reject; *do not* expect nextBadType to reject.
      function nextBadType(i, args) {
        if (argIdx >= refArgs.length)
          return Promise.reject(new Error('Fix this test code'))
        if (i >= notStrings.length)
          return Promise.resolve(true)
        args[argIdx] = notStrings[i]
        return mergeLib.merge(args)
        .then(() => false)
        .catch(err => {
          if (err instanceof TypeError) {
            args[argIdx] = refArgs[argIdx]
            return nextBadType(++i, args)
          }
          throw new Error("Wrong error type for bad path argument type")
        })
      }

      nextBadType(0, refArgs.slice())
      .then(seqResult => {
        if (!seqResult) throw didNotError
        ++argIdx // Choose next path arg position
        return nextBadType(0, refArgs.slice())
      })
      .then(seqResult => {
        if (!seqResult) throw didNotError
        ++argIdx // Choose next path arg position
        return nextBadType(0, refArgs.slice())
      })
      .then(seqResult => {
        if (!seqResult) throw didNotError
        return done()
      })
      .catch(err => done(err))
    })

    it('should reject when given wrong type for opts', function(done) {
      function nextBadOpts(i) {
        if (i >= notSimpleObjects.length) return Promise.resolve(null)

        return mergeLib.merge([path1, path2], notSimpleObjects[i])
        .then(() => ({ value: notSimpleObjects[i] }))
        .catch(err => {
          expect(err).to.be.an.instanceof(TypeError)
          return nextBadOpts(++i)
        })
      }

      nextBadOpts(0)
      .then(problem => {
        if (problem) {
          const err = new Error('Failed to reject on options value: ' + problem.value)
          return done(err)
        }
        return done()
      })
      .catch(err => done(err))
    })

    it('should reject when move option is given with wrong type', function(done) {
      const notBooleans = [
        undefined, null, 1, 'true', {a: true}, [true], function(){return true}
      ]
      function nextBadMoveOpt(i) {
        if (i >= notBooleans.length) return Promise.resolve(null)

        return mergeLib.merge([path1, path2], { move: notBooleans[i] })
        .then(() => ({ value: notBooleans[i] }))
        .catch(err => {
          expect(err).to.be.an.instanceof(TypeError)
          return nextBadMoveOpt(++i)
        })
      }

      nextBadMoveOpt(0)
      .then(problem => {
        if (problem) {
          const err = new Error('Failed to reject on move option value: ' + problem.value)
          return done(err)
        }
        return done()
      })
      .catch(err => done(err))
    })

    it('should reject on a non-existent path of any but last of at least 3', function(done) {
      const NO_SUCH_PATH = 'DOES/NOT/EXIST'
      mergeLib.merge([NO_SUCH_PATH, path1])
      .then(() => done(didNotError))
      .catch(err => {
        if (err.code == 'ENOENT') {
          return mergeLib.merge([path1, NO_SUCH_PATH])
          .then(() => done(didNotError))
        }
        return done(err)
      })
      .catch(err => {
        if (err.code == 'ENOENT') {
          return mergeLib.merge([path1, path2, NO_SUCH_PATH, path3])
          .then(() => done(didNotError))
        }
        return done(err)
      })
      .catch(err => {
        expect(err.code).to.equal('ENOENT')
        done()
      })
      .catch(err => done(err))
    })
  })

  describe('merge() correct use', function() {

    it('should result in an empty directory for two empty source directories', function(done) {
      mergeLib.merge([ emptyPath1, emptyPath2 ])
      .then(() => expectErrorFreeAudit(emptyPath2))
      // (Silly, but) verify that emptyPath2 is still empty
      .then(() => readdirAsync(emptyPath2))
      .then(dirContents => {
        if (dirContents.length)
          return done(new Error("The union of empty directories is not empty?!"))
        return done()
      })
      .catch(err => done(err))
    })

    it('should result in a copy of the 1st dir when the 2nd dir is empty', function(done) {
      configureTestDir(path1, 'dltracker_ALL_GOOD.json')
      .then(srcMap => {
        return readdirAsync(path1)
        .then(path1ListBefore => {
           mergeLib.merge([ path1, path2 ])
          .then(() => expectErrorFreeAudit(path2))
          // As well as verifying that the JSON conforms to the tracker schema,
          // tracker.audit verifies that every file named in the JSON exists in
          // the target directory. All we need to do now is verify that the target
          // JSON contains every record of the source JSON.
          .then(tracker => evalJsonFile(path.join(path2, MAPFILE_NAME)))
          .then(resultMap => {
            stripMetadata(resultMap)
            // What remains must match.
            expect(resultMap).to.deep.equal(srcMap)
            return readdirAsync(path1)
          })
          .then(path1ListAfter => {
            expect(path1ListAfter).to.deep.equal(path1ListBefore)
            done()
          })
        })
      })
      .catch(err => done(err))
    })

    it('should yield union of 2 dirs in 2nd dir, given 2 disjoint dirs', function(done) {
      configureTestDir(path1, 'dltracker_DISTINCT_1.json', true)
      .then(srcMap1 => {
        return readdirAsync(path1)
        .then(path1ListBefore => {
          return configureTestDir(path2, 'dltracker_DISTINCT_2.json', true)
          .then(srcMap2 => {
            return mergeLib.merge([ path1, path2 ])
            .then(() => expectErrorFreeAudit(path2))
            .then(tracker => {
              expectTrackerToHaveAll(tracker, srcMap1)
              expectTrackerToHaveAll(tracker, srcMap2)
              return readdirAsync(path1)
            })
            .then(path1ListAfter => {
              expect(path1ListAfter).to.deep.equal(path1ListBefore)
            })
          })
        })
      })
      .then(() => {
        // Verifying that the tarballs in the source directory are all present
        // in the target directory may be overkill, but I'm going to call it
        // "insurance".
        expectCopiesOfTarballs(path1, path2).then(() => done())
      })
      .catch(err => done(err))
    })

    it('should yield union of 2 dirs in 2nd dir, given 2 dirs that are not disjoint', function(done) {
      configureTestDir(path1, 'dltracker_DISTINCT_1.json', true)
      .then(srcMap1 => {
        return readdirAsync(path1)
        .then(path1ListBefore => {
          return configureTestDir(path2, 'dltracker_OVERLAP_1.json', true)
          .then(srcMap2 => {
            return mergeLib.merge([ path1, path2 ])
            .then(() => expectErrorFreeAudit(path2))
            .then(tracker => {
              expectTrackerToHaveAll(tracker, srcMap1)
              expectTrackerToHaveAll(tracker, srcMap2)
              return readdirAsync(path1)
            })
            .then(path1ListAfter => {
              expect(path1ListAfter).to.deep.equal(path1ListBefore)
            })
          })
        })
      })
      .then(() => {
        expectCopiesOfTarballs(path1, path2).then(() => done())
      })
      .catch(err => done(err))
    })

    it('should create union of 2 dirs in nonexistent 3rd directory', function(done) {
      const newPath = path.join(TEMPDIR_BASE, nextNoSuchDirName())
      evalJsonFile(path.join(path1, MAPFILE_NAME))
      .then(srcMap1 => {
        return readdirAsync(path1)
        .then(path1ListBefore => {
          return configureTestDir(path2, 'dltracker_DISTINCT_2.json', true)
          .then(srcMap2 => {
            return readdirAsync(path2)
            .then(path2ListBefore => {
              return mergeLib.merge([ path1, path2, newPath ])
              .then(() => expectErrorFreeAudit(newPath))
              .then(tracker => {
                expectTrackerToHaveAll(tracker, srcMap1)
                expectTrackerToHaveAll(tracker, srcMap2)
                return readdirAsync(path1)
              })
              .then(path1ListAfter => {
                expect(path1ListAfter).to.deep.equal(path1ListBefore)
                return readdirAsync(path2)
              })
              .then(path2ListAfter => {
                expect(path2ListAfter).to.deep.equal(path2ListBefore)
              })
            })
          })
        })
      })
      // "insurance".
      .then(() => expectCopiesOfTarballs(path1, newPath))
      .then(() => expectCopiesOfTarballs(path2, newPath))
      .then(() => done())
      .catch(err => done(err))
    })

    it('should create union of 2 dirs in empty 3rd directory', function(done) {
      evalJsonFile(path.join(path1, MAPFILE_NAME))
      .then(srcMap1 => {
        return readdirAsync(path1)
        .then(path1ListBefore => {
          return evalJsonFile(path.join(path2, MAPFILE_NAME))
          .then(srcMap2 => {
            return readdirAsync(path2)
            .then(path2ListBefore => {
              return mergeLib.merge([ path1, path2, path3 ])
              .then(() => expectErrorFreeAudit(path3))
              .then(tracker => {
                expectTrackerToHaveAll(tracker, srcMap1)
                expectTrackerToHaveAll(tracker, srcMap2)
                return readdirAsync(path1)
              })
              .then(path1ListAfter => {
                expect(path1ListAfter).to.deep.equal(path1ListBefore)
                return readdirAsync(path2)
              })
              .then(path2ListAfter => {
                expect(path2ListAfter).to.deep.equal(path2ListBefore)
              })
            })
          })
        })
      })
      // "insurance".
      .then(() => expectCopiesOfTarballs(path1, path3))
      .then(() => expectCopiesOfTarballs(path2, path3))
      .then(() => done())
      .catch(err => done(err))
    })

    // At this point, path1 is unchanged since last configured with dltracker_DISTINCT_1.json;
    // path2 is unchanged since it was last configured with dltracker_DISTINCT_2.json.
    // We will reconfigure path3 in the following test.

    it('should create union of 3 dirs in nonexistent 4th directory', function(done) {
      const newPath = path.join(TEMPDIR_BASE, nextNoSuchDirName())
      evalJsonFile(path.join(path1, MAPFILE_NAME))
      .then(srcMap1 => {
        return readdirAsync(path1)
        .then(path1ListBefore => {
          return evalJsonFile(path.join(path2, MAPFILE_NAME))
          .then(srcMap2 => {
            return readdirAsync(path2)
            .then(path2ListBefore => {
              return configureTestDir(path3, 'dltracker_OVERLAP_2.json', true)
              .then(srcMap3 => {
                return readdirAsync(path3)
                .then(path3ListBefore => {
                  return mergeLib.merge([ path1, path2, path3, newPath ])
                  .then(() => expectErrorFreeAudit(newPath))
                  .then(tracker => {
                    expectTrackerToHaveAll(tracker, srcMap1)
                    expectTrackerToHaveAll(tracker, srcMap2)
                    expectTrackerToHaveAll(tracker, srcMap3)
                    return readdirAsync(path1)
                  })
                  .then(path1ListAfter => {
                    expect(path1ListAfter).to.deep.equal(path1ListBefore)
                    return readdirAsync(path2)
                  })
                  .then(path2ListAfter => {
                    expect(path2ListAfter).to.deep.equal(path2ListBefore)
                    return readdirAsync(path3)
                  })
                  .then(path3ListAfter => {
                    expect(path3ListAfter).to.deep.equal(path3ListBefore)
                  })
                })
              })
            })
          })
        })
      })
      // "insurance"
      .then(() => expectCopiesOfTarballs(path1, newPath))
      .then(() => expectCopiesOfTarballs(path2, newPath))
      .then(() => expectCopiesOfTarballs(path3, newPath))
      .then(() => done())
      .catch(err => done(err))
    })

  })

  describe('merge() correct use, with Move option', function() {

    it('should result in an empty dir for 2 empty source dirs, and removal of the 1st', function(done) {
      mergeLib.merge([ emptyPath1, emptyPath2 ], { move: true })
      .then(() => expectErrorFreeAudit(emptyPath2))
      // (Silly, but) verify that emptyPath2 is still empty
      .then(() => readdirAsync(emptyPath2))
      .then(dir2List => {
        if (dir2List.length)
          return done(new Error('The union of empty directories is not empty?!'))
        // Verify that the 1st directory is gone
        return readdirAsync(emptyPath1)
        .then(dir1List => done(new Error('Expected first path to be deleted')))
        .catch(err => {
          if (err.code != 'ENOENT') throw err
          return done()
        })
      })
      .catch(err => done(err))

    })

    it('should result in a copy of the 1st dir when the 2nd dir is empty, and removal of the 1st', function(done) {
      configureTestDir(path1, 'dltracker_ALL_GOOD.json', true)
      .then(srcMap => {
        recreateDir(path2)
        .then(() => mergeLib.merge([ path1, path2 ], { move: true }))
        .then(() => expectErrorFreeAudit(path2))
        // As well as verifying that the JSON conforms to the tracker schema,
        // tracker.audit verifies that every file named in the JSON exists in
        // the target directory. All we need to do now is verify that the target
        // JSON contains every record of the source JSON.
        .then(tracker => evalJsonFile(path.join(path2, MAPFILE_NAME)))
        .then(resultMap => {
          stripMetadata(resultMap)
          // What remains must match.
          expect(resultMap).to.deep.equal(srcMap)
          // Verify that the 1st directory is gone
          return readdirAsync(path1)
          .then(dir1List => done(new Error('Expected first path to be deleted')))
          .catch(err => {
            if (err.code != 'ENOENT') throw err
            return done()
          })
        })
        .catch(err => done(err))
      })
    })

    it('should yield union of 2 dirs in 2nd dir given 2 disjoint dirs, and removal of the 1st', function(done) {
      configureTestDir(path1, 'dltracker_DISTINCT_1.json', true)
      .then(srcMap1 => {
        return configureTestDir(path2, 'dltracker_DISTINCT_2.json', true)
        .then(srcMap2 => {
          return getDirContentData(path1)
          .then(srcFileData => {
            return mergeLib.merge([ path1, path2 ], { move: true })
            .then(() => expectErrorFreeAudit(path2))
            .then(tracker => {
              expectTrackerToHaveAll(tracker, srcMap1)
              expectTrackerToHaveAll(tracker, srcMap2)
            })
            .then(() => expectCopiesOfTarballs2(srcFileData, path2))
            .then(() => readdirAsync(path1))
            .then(dir1List => {
              throw new Error('Expected first path to be deleted')
            })
            .catch(err => {
              if (err.code != 'ENOENT') throw err
            })
          })
        })
      })
      .then(() => done())
      .catch(err => done(err))
    })

    it('should yield union of 2 dirs in 2nd dir given 2 dirs that are not disjoint, and removal of the 1st', function(done) {
      configureTestDir(path1, 'dltracker_DISTINCT_1.json', true)
      .then(srcMap1 => {
        return configureTestDir(path2, 'dltracker_OVERLAP_1.json', true)
        .then(srcMap2 => {
          return getDirContentData(path1)
          .then(srcFileData => {
            return mergeLib.merge([ path1, path2 ], { move: true })
            .then(() => expectErrorFreeAudit(path2))
            .then(tracker => {
              expectTrackerToHaveAll(tracker, srcMap1)
              expectTrackerToHaveAll(tracker, srcMap2)
            })
            .then(() => expectCopiesOfTarballs2(srcFileData, path2))
            .then(() => readdirAsync(path1))
            .then(dir1List => {
              throw new Error('Expected first path to be deleted')
            })
            .catch(err => {
              if (err.code != 'ENOENT') throw err
            })
          })
        })
      })
      .then(() => done())
      .catch(err => done(err))
    })

    it('should create union of 2 dirs in nonexistent 3rd directory, and remove the 2 source dirs', function(done) {
      const newPath = path.join(TEMPDIR_BASE, nextNoSuchDirName())
      configureTestDir(path1, 'dltracker_DISTINCT_1.json', true)
      .then(srcMap1 => {
        return configureTestDir(path2, 'dltracker_DISTINCT_2.json', true)
        .then(srcMap2 => {
          return getDirContentData(path1)
          .then(src1FileData => {
            return getDirContentData(path2)
            .then(src2FileData => {
              return mergeLib.merge([ path1, path2, newPath ], { move: true })
              .then(() => expectErrorFreeAudit(newPath))
              .then(tracker => {
                expectTrackerToHaveAll(tracker, srcMap1)
                expectTrackerToHaveAll(tracker, srcMap2)
              })
              .then(() => expectCopiesOfTarballs2(src1FileData, newPath))
              .then(() => expectCopiesOfTarballs2(src2FileData, newPath))
              .then(() => readdirAsync(path1))
              .then(dirList => {
                throw new Error('Expected first path to be deleted')
              })
              .catch(err => {
                if (err.code != 'ENOENT') throw err
              })
              .then(() => readdirAsync(path2))
              .then(dirList => {
                throw new Error('Expected second path to be deleted')
              })
              .catch(err => {
                if (err.code != 'ENOENT') throw err
              })
            })
          })
        })
      })
      .then(() => done())
      .catch(err => done(err))
    })

    it('should create union of 2 dirs in empty 3rd directory, and remove the 2 source dirs', function(done) {
      configureTestDir(path1, 'dltracker_DISTINCT_1.json', true)
      .then(srcMap1 => {
        return configureTestDir(path2, 'dltracker_DISTINCT_2.json', true)
        .then(srcMap2 => {
          return getDirContentData(path1)
          .then(src1FileData => {
            return getDirContentData(path2)
            .then(src2FileData => {
              return mergeLib.merge([ path1, path2, path3 ], { move: true })
              .then(() => expectErrorFreeAudit(path3))
              .then(tracker => {
                expectTrackerToHaveAll(tracker, srcMap1)
                expectTrackerToHaveAll(tracker, srcMap2)
              })
              .then(() => expectCopiesOfTarballs2(src1FileData, path3))
              .then(() => expectCopiesOfTarballs2(src2FileData, path3))
              .then(() => readdirAsync(path1))
              .then(dirList => {
                throw new Error('Expected first path to be deleted')
              })
              .catch(err => {
                if (err.code != 'ENOENT') throw err
              })
              .then(() => readdirAsync(path2))
              .then(dirList => {
                throw new Error('Expected second path to be deleted')
              })
              .catch(err => {
                if (err.code != 'ENOENT') throw err
              })
            })
          })
        })
      })
      .then(() => done())
      .catch(err => done(err))
    })

    it('should create union of 3 dirs in nonexistent 4th directory, and remove the 3 source dirs', function(done) {
      const newPath = path.join(TEMPDIR_BASE, nextNoSuchDirName())
      configureTestDir(path1, 'dltracker_DISTINCT_1.json', true)
      .then(srcMap1 => {
        return configureTestDir(path2, 'dltracker_DISTINCT_2.json', true)
        .then(srcMap2 => {
          return configureTestDir(path3, 'dltracker_OVERLAP_2.json', true)
          .then(srcMap3 => {
            return getDirContentData(path1)
            .then(src1FileData => {
              return getDirContentData(path2)
              .then(src2FileData => {
                return getDirContentData(path3)
                .then(src3FileData => {
                  return mergeLib.merge([ path1, path2, path3, newPath ], { move: true })
                  .then(() => expectErrorFreeAudit(newPath))
                  .then(tracker => {
                    expectTrackerToHaveAll(tracker, srcMap1)
                    expectTrackerToHaveAll(tracker, srcMap2)
                    expectTrackerToHaveAll(tracker, srcMap3)
                  })
                  .then(() => expectCopiesOfTarballs2(src1FileData, newPath))
                  .then(() => expectCopiesOfTarballs2(src2FileData, newPath))
                  .then(() => expectCopiesOfTarballs2(src3FileData, newPath))
                  .then(() => readdirAsync(path1))
                  .then(dirList => {
                    throw new Error('Expected first path to be deleted')
                  })
                  .catch(err => {
                    if (err.code != 'ENOENT') throw err
                  })
                  .then(() => readdirAsync(path2))
                  .then(dirList => {
                    throw new Error('Expected second path to be deleted')
                  })
                  .catch(err => {
                    if (err.code != 'ENOENT') throw err
                  })
                  .then(() => readdirAsync(path3))
                  .then(dirList => {
                    throw new Error('Expected third path to be deleted')
                  })
                  .catch(err => {
                    if (err.code != 'ENOENT') throw err
                  })
                })
              })
            })
          })
        })
      })
      .then(() => done())
      .catch(err => done(err))
    })

  })

})
