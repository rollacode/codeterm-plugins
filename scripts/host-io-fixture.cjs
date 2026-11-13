function attachHostIo(host) {
  if (!host || (typeof host !== 'object' && typeof host !== 'function') || Object.getOwnPropertyDescriptor(host, 'io')) return host;
  const run = steps => {
    const resolve = value => value && typeof value.next === 'function' ? run(value) : value;
    const resume = (value, failed = false) => {
      const next = failed ? steps.throw(value) : steps.next(value);
      if (next.done) return resolve(next.value);
      const request = next.value;
      if (request.op === 'fetch' && typeof host.fetch !== 'function' && typeof host.fetch?.async === 'function') return host.fetch.async(request.options, reply => resume(reply));
      if (request.op === 'awaitJob' && typeof host.awaitJob === 'function') return host.awaitJob(request.job, reply => resume(reply));
      let reply;
      try { reply = execute(request); } catch (error) { return resume(error, true); }
      return resume(reply);
    };
    const execute = r => {
      const fs = host.fs || {};
      const filesystem = name => typeof fs[name] === 'function' ? fs[name].bind(fs) : typeof host[name] === 'function' ? host[name].bind(host) : null;
      const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
      if (r.op === 'exec') return parse(host.exec(JSON.stringify(r.options)));
      if (r.op === 'fetch') return parse(host.fetch(JSON.stringify(r.options)));
      if (r.op === 'execStart') return host.exec?.start ? host.exec.start(r.options) : parse(host.execStart(JSON.stringify(r.options)));
      if (r.op === 'execPoll') return host.exec?.poll ? host.exec.poll(r.job) : parse(host.execPoll(r.job));
      if (r.op === 'execClose') return host.exec?.close ? host.exec.close(r.job) : host.execClose?.(r.job);
      if (r.op === 'fetchStart') return parse(host.fetchStart(JSON.stringify(r.options)));
      if (r.op === 'fetchStreamStart') return host.fetch.stream(r.options);
      if (r.op === 'fetchStreamPoll') return host.fetch.streamPoll(r.job);
      if (r.op === 'fetchStreamClose') return host.fetch.streamClose(r.job);
      if (r.op === 'projectWriteAllowed') return host.projectWriteAllowed(r.root);
      if (/^secret/.test(r.op)) return host[r.op](r.name, r.value);
      if (r.op === 'credentialPublic') { const value = host.credentialPublic(r.id); return value == null ? null : parse(value); }
      if (r.op === 'memSearch') return host.mem.search(r.options);
      if (r.op === 'workerStart') return host.worker.start(r.options);
      if (r.op === 'workerPoll') return host.worker.poll(r.job);
      if (r.op === 'receiverTarget') return host.receiverTarget.get();
      if (r.op === 'receiverTargetClear') return host.receiverTarget.clear();
      if (r.op === 'receiverStatusReport') return host.localRecording.statusReport();
      if (r.op === 'localRecordingStatus') return host.localRecording.status();
      if (r.op === 'localRecordingSetEnabled') return host.localRecording.setEnabled(r.enabled);
      if (r.op === 'progress') return host.progress?.(r.options);
      const fn = filesystem(r.op);
      if (!fn) {
        if (r.op === 'lockFile') return r.path;
        if (r.op === 'unlockFile') return true;
        if (r.op === 'writeFileAtomic') return filesystem('writeFile')(r.path, r.contents);
        if (r.op === 'readDir') return [];
        if (r.op === 'listChildDirs') return [];
        throw new Error('Fixture has no host operation: ' + r.op);
      }
      if (r.op === 'unlockFile') return fn(r.id);
      if (r.op === 'writeTempFile') return fn(r.contents, r.suffix);
      if (r.op === 'writeFile' || r.op === 'writeFileAtomic') return fn(r.path, r.contents);
      if (r.op === 'writeJson') return fn(r.path, r.value);
      if (r.op === 'readFileHead' || r.op === 'readFileTail') return fn(r.path, r.maxBytes);
      if (r.op === 'walkDir') return fn(r.path, r.maxDepth);
      return fn(r.path);
    };
    return resume();
  };
  const io = (request, then) => run((function* () { return then(yield request); })());
  io.run = run;
  io.exec = function* (options) { return yield { op: 'exec', options }; };
  io.fetch = function* (options) { return yield { op: 'fetch', options }; };
  io.fs = {};
  for (const op of ['readFile', 'readJson', 'readDir', 'fileExists', 'listChildDirs', 'isSymlink', 'canonicalPath', 'lockFile', 'removeFile', 'makeDirs']) io.fs[op] = function* (path) { return yield { op, path }; };
  for (const op of ['readFileHead', 'readFileTail']) io.fs[op] = function* (path, maxBytes) { return yield { op, path, maxBytes }; };
  for (const op of ['writeFile', 'writeFileAtomic']) io.fs[op] = function* (path, contents) { return yield { op, path, contents }; };
  io.fs.writeJson = function* (path, value) { return yield { op: 'writeJson', path, value }; };
  io.fs.unlockFile = function* (id) { return yield { op: 'unlockFile', id }; };
  io.fs.writeTempFile = function* (contents, suffix) { return yield { op: 'writeTempFile', contents, suffix }; };
  io.fs.walkDir = function* (path, maxDepth) { return yield { op: 'walkDir', path, maxDepth }; };
  Object.defineProperty(host, 'io', { value: io, configurable: true });
  for (const name of ['exec', 'fetch']) {
    const async = Object.getOwnPropertyDescriptor(host, name)?.value?.async;
    if (async) host[name].async = (opts, then) => async(opts, result => {
      const value = then(result);
      return value && typeof value.next === 'function' ? run(value) : value;
    });
  }
  return new Proxy(host, { get(target, key, receiver) { return key === "io" ? io : Reflect.get(target, key, receiver); } });
}
function installTestHostIo(target = globalThis) {
  let host = target.host;
  Object.defineProperty(target, 'host', {
    configurable: true,
    get: () => host,
    set: value => { host = attachHostIo(value); },
  });
  if (host) target.host = host;
}
module.exports = { attachHostIo, installTestHostIo };
