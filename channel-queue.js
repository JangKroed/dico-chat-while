// Same-channel work is ordered; independent channels do not wait for one another.
export function createChannelQueue() {
  const tails = new Map();
  let barrier = Promise.resolve();
  const track = (key, task) => {
    const settled = task.catch(() => {});
    tails.set(key, settled);
    void settled.then(() => { if (tails.get(key) === settled) tails.delete(key); });
    return task;
  };
  return {
    run(key, action) { return track(key, Promise.all([barrier, tails.get(key)]).then(action)); },
    exclusive(action) {
      const task = Promise.all([barrier, ...tails.values()]).then(action);
      barrier = task.catch(() => {});
      return task;
    },
  };
}
