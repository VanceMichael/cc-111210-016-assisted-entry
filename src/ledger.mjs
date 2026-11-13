import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// 台账只记录动作与对象标识（key/version），绝不写入页面中的人员资料或确认说明文本。
export class Ledger {
  constructor(path) {
    this.path = path;
    this.events = [];
  }
  async load() {
    try {
      const lines = (await readFile(this.path, 'utf8')).split('\n').filter(Boolean);
      this.events = lines.map(line => JSON.parse(line));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  async record({ actor, action, session = null, ticket = null, detail = {} }) {
    const event = { seq: this.events.length + 1, time: new Date().toISOString(), actor, action, session, ticket, detail };
    this.events.push(event);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(event) + '\n');
    return event;
  }
  query({ session } = {}) {
    return this.events.filter(event => !session || event.session === session);
  }
}
