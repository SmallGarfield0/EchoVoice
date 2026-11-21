type ActiveTask = {
  key: string;
  promise: Promise<void>;
};

export class KeyedTaskCoordinator {
  private activeTask: ActiveTask | null = null;

  get active() {
    return this.activeTask !== null;
  }

  run(key: string, task: () => Promise<void>): Promise<void> {
    const active = this.activeTask;
    if (active) {
      if (active.key === key) return active.promise;
      return active.promise.catch(() => undefined).then(() => this.run(key, task));
    }

    let entry: ActiveTask | null = null;
    const promise = Promise.resolve()
      .then(task)
      .finally(() => {
        if (entry && this.activeTask === entry) this.activeTask = null;
      });
    entry = { key, promise };
    this.activeTask = entry;
    return promise;
  }
}
