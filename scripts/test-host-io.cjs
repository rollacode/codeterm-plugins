// Synchronous driver for existing in-memory host fixtures. Production has no
// fallback: host.io submits work and resumes the original iterator off the VM.
function installTestHostIo(target = globalThis) {
  const initial = target.host;
  let current;
  Object.defineProperty(target, 'host', {
    configurable: true,
    get: () => current,
    set(value) {
      current = value;
      if (!value || Object.getOwnPropertyDescriptor(value, 'io')) return;
      const run = steps => {
        if (!steps || typeof steps.next !== 'function') return steps;
        let reply;
        let failure;
        while (true) {
          let next;
          try { next = failure ? steps.throw(failure) : steps.next(reply); failure = undefined; } catch (error) { throw error; }
          if (next.done) return next.value;
          const r = next.value;
          try {
            if (r.op === 'exec') { reply = JSON.parse(value.exec(JSON.stringify(r.options))); if (reply.simulatedTimeout) reply = { error: 'simulated lost response timeout', done: true }; }
            else if (r.op === 'execStart') reply = value.exec && value.exec.start ? value.exec.start(r.options) : JSON.parse(value.execStart(JSON.stringify(r.options)));
            else if (r.op === 'fetch') reply = JSON.parse(value.fetch(JSON.stringify(r.options)));
            else if (r.op === 'lockFile') reply = r.path;
            else if (r.op === 'unlockFile') reply = true;
            else if (/^secret/.test(r.op)) reply = value[r.op](r.name, r.value);
            else {
              const op = r.op === 'writeFileAtomic' ? 'writeFile' : r.op;
              const obj = value.fs && typeof value.fs[op] === 'function' ? value.fs : value;
              reply = obj[op](r.path, ...(r.args || []));
            }
          } catch(error) {
            failure = error;
          }
        }
      };
      const io = { run, fs: {}, exec: function*(options) { return yield {op:'exec',options}; }, fetch: function*(options) { return yield {op:'fetch',options}; } };
      for(const op of ['readFile','readFileHead','readFileTail','writeFile','writeFileAtomic','fileExists','makeDirs','removeFile','readDir','readJson','writeJson','lockFile','unlockFile','isSymlink','canonicalPath']) io.fs[op]=function*(path,...args){return yield {op,path,args};};
      value.io=io;
      if (Object.getOwnPropertyDescriptor(value, 'exec')?.value?.async) {
        const asyncExec=value.exec.async;
        value.exec.async=(opts,then)=>asyncExec(opts,result=>run(then(result)));
      }
    },
  });
  if (initial) target.host = initial;
}
module.exports = { installTestHostIo };
