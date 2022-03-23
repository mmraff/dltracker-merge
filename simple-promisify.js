module.exports = (f) => {
  return (...args) => {
    return new Promise((resolve, reject) => {
      args.push((err, result) => {
        if (err) return reject(err)
        resolve(result)
      })
      f.call(this, ...args)
    })
  }
}
