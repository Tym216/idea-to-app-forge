import { Daytona } from '@daytona/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Daytona 执行环境适配器,基于官方 SDK `@daytona/sdk`(原 @daytonaio/sdk 已更名)。
 *
 * 旧实现手工拼接 `${DAYTONA_API_URL}/toolbox/{id}/toolbox/process/execute`,
 * 但 Toolbox 请求应发往沙箱自己的 toolbox 基址(由 API 返回),且路径中 toolbox 重复,
 * 因此报 `Cannot POST`。现在全部改为 SDK 方法,SDK 会自行解析每个沙箱的 toolbox 地址。
 * 不再有任何手工拼接的 REST 路径。
 */
const APP_DIR = 'app';
const DEV_SESSION = 'forge-dev';

export class DaytonaProvider {
  constructor() {
    if (!config.daytonaApiKey) {
      throw new Error('DAYTONA_API_KEY 未配置,无法使用 Daytona 执行环境。');
    }
    this.client = new Daytona({
      apiKey: config.daytonaApiKey,
      apiUrl: config.daytonaApiUrl,
      target: config.daytonaTarget,
    });
    this.cache = new Map(); // sandboxId -> { sandbox, workdir }
    this.workdir = `~/${APP_DIR}`;
  }

  /** 获取沙箱对象及其绝对工作目录(不同镜像的 home 不同,运行时解析)。 */
  async resolve(sandboxId) {
    const cached = this.cache.get(sandboxId);
    if (cached) return cached;
    const sandbox = await this.client.get(sandboxId);
    const home = (await sandbox.process.executeCommand('printf %s "$HOME"', undefined, undefined, 30)).result.trim();
    const workdir = `${home || '/home/daytona'}/${APP_DIR}`;
    await sandbox.process.executeCommand(`mkdir -p ${JSON.stringify(workdir)}`, undefined, undefined, 30);
    const entry = { sandbox, workdir };
    this.cache.set(sandboxId, entry);
    this.workdir = workdir;
    return entry;
  }

  abs(workdir, path) {
    if (path.startsWith('/')) return path;
    const clean = path.replace(/^\.\//, '').replace(/^~\/app\/?/, '');
    return clean ? `${workdir}/${clean}` : workdir;
  }

  /** owner: { projectId, userId } 写入标签,用于孤儿沙箱核对(仅凭标签判断归属,不凭创建时间)。 */
  async create(owner = {}) {
    const sandbox = await this.client.create(
      {
        language: 'typescript',
        autoStopInterval: config.daytonaAutoStopMinutes,
        labels: sandboxLabels(owner),
        ...(config.daytonaSnapshot ? { snapshot: config.daytonaSnapshot } : {}),
      },
      { timeout: 180 }
    );
    logger.info('daytona.created', { sandboxId: sandbox.id });
    this.cache.delete(sandbox.id);
    await this.resolve(sandbox.id);
    return { sandboxId: sandbox.id };
  }

  /** 沙箱可能已停止或被回收:停止则启动,不存在则重建。 */
  async ensure(sandboxId, owner = {}) {
    if (!sandboxId) return { ...(await this.create(owner)), alive: false };
    try {
      const sandbox = await this.client.get(sandboxId);
      const state = String(sandbox.state || '').toLowerCase();
      if (state && state !== 'started') {
        logger.info('daytona.starting', { sandboxId, state });
        await this.client.start(sandbox, 180);
      }
      this.cache.delete(sandboxId);
      await this.resolve(sandboxId);
      return { sandboxId, alive: true };
    } catch (error) {
      logger.warn('daytona.ensure.recreate', { sandboxId, error: String(error?.message || error) });
      return { ...(await this.create(owner)), alive: false };
    }
  }

  /** 新建、恢复与打开已有项目使用相同的闲置停止策略；不设置永久保活。 */
  async configureIdle(sandbox) {
    const minutes = config.daytonaAutoStopMinutes;
    if (!Number.isInteger(minutes) || minutes < 1) throw new Error('DAYTONA_AUTO_STOP_MINUTES 必须是正整数');
    if (sandbox.autoStopInterval !== minutes) await sandbox.setAutostopInterval(minutes);
  }

  /**
   * 同步执行命令。SDK 的 timeout 单位是秒;另加客户端兜底计时器。
   * 超时返回 timedOut=true,由调用方先 checkProcess 再决定是否重试。
   * 注意:executeCommand 把 stdout/stderr 合并在 result 中。
   */
  async exec(sandboxId, command, { timeoutMs = config.commandTimeoutMs, cwd } = {}) {
    const { sandbox, workdir } = await this.resolve(sandboxId);
    const started = Date.now();
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    let timer;
    try {
      const response = await Promise.race([
        sandbox.process.executeCommand(command, cwd ? this.abs(workdir, cwd) : workdir, undefined, seconds),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`client timeout after ${timeoutMs}ms`)), timeoutMs + 15000);
        }),
      ]);
      return {
        exitCode: response.exitCode ?? 0,
        stdout: response.result ?? '',
        stderr: '',
        timedOut: false,
        ms: Date.now() - started,
      };
    } catch (error) {
      const message = String(error?.message || error);
      if (/timeout|timed out|abort/i.test(message)) {
        return { exitCode: -1, stdout: '', stderr: message, timedOut: true, ms: Date.now() - started };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 超时后判断目标进程是否仍在运行。 */
  async checkProcess(sandboxId, pattern) {
    const result = await this.exec(sandboxId, `pgrep -f ${JSON.stringify(pattern)} || true`, { timeoutMs: 20000 });
    return result.stdout.trim().length > 0;
  }

  /** 判断端口是否已在监听(用于开发服务器就绪检测)。 */
  async isPortListening(sandboxId, port) {
    const result = await this.exec(
      sandboxId,
      `(command -v curl >/dev/null && curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}) || true`,
      { timeoutMs: 20000 }
    );
    return /^[1-5]\d\d$/.test(result.stdout.trim());
  }

  /**
   * 后台启动长时进程(开发服务器):使用 session + runAsync,不阻塞、不受同步命令超时影响。
   * 返回 { commandId } 以便读取日志。
   */
  async startBackground(sandboxId, command, { sessionId = DEV_SESSION } = {}) {
    const { sandbox, workdir } = await this.resolve(sandboxId);
    try {
      await sandbox.process.deleteSession(sessionId);
    } catch {
      /* 会话不存在时忽略 */
    }
    await sandbox.process.createSession(sessionId);
    const response = await sandbox.process.executeSessionCommand(sessionId, {
      command: `cd ${JSON.stringify(workdir)} && ${command}`,
      runAsync: true,
    });
    return { sessionId, commandId: response.cmdId };
  }

  async readLogs(sandboxId, { sessionId = DEV_SESSION, commandId } = {}) {
    if (!commandId) return '';
    const { sandbox } = await this.resolve(sandboxId);
    const logs = await sandbox.process.getSessionCommandLogs(sessionId, commandId);
    return [logs?.stdout || logs?.output || '', logs?.stderr || ''].filter(Boolean).join('\n');
  }

  async writeFile(sandboxId, path, content) {
    const { sandbox, workdir } = await this.resolve(sandboxId);
    const full = this.abs(workdir, path);
    const dir = full.slice(0, full.lastIndexOf('/'));
    if (dir) await sandbox.process.executeCommand(`mkdir -p ${JSON.stringify(dir)}`, undefined, undefined, 30);
    await sandbox.fs.uploadFile(Buffer.from(content, 'utf8'), full);
  }

  async readFile(sandboxId, path) {
    const { sandbox, workdir } = await this.resolve(sandboxId);
    const buffer = await sandbox.fs.downloadFile(this.abs(workdir, path));
    return Buffer.from(buffer).toString('utf8');
  }

  /** 列出工作目录下的文件(排除依赖与构建产物)。 */
  async listFiles(sandboxId, dir = '.') {
    const result = await this.exec(
      sandboxId,
      `find . -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './dist/*' | head -300`,
      { timeoutMs: 30000, cwd: dir === '.' || dir.startsWith('~') ? undefined : dir }
    );
    return result.stdout.split('\n').map((line) => line.replace(/^\.\//, '').trim()).filter(Boolean);
  }

  /**
   * 预览地址。私有沙箱的预览需要 token(请求头 x-daytona-preview-token),
   * iframe 无法带自定义头,因此优先使用带签名的 URL;失败时退回普通预览链接。
   */
  async previewUrl(sandboxId, port = 5173) {
    const { sandbox } = await this.resolve(sandboxId);
    try {
      const signed = await sandbox.getSignedPreviewUrl(port, 24 * 3600);
      if (signed?.url) return signed.url;
    } catch (error) {
      logger.warn('daytona.signed_preview.failed', { sandboxId, error: String(error?.message || error) });
    }
    const link = await sandbox.getPreviewLink(port);
    return link?.url || '';
  }

  /** 只删除指定 ID 的沙箱;不存在视为已清理,返回 { existed:false }。其他错误原样抛出。 */
  async destroy(sandboxId) {
    let sandbox;
    try {
      sandbox = await this.client.get(sandboxId);
    } catch (error) {
      if (isNotFound(error)) return { existed: false };
      throw error;
    }
    try {
      await this.client.delete(sandbox, 120);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    this.cache.delete(sandboxId);
    return { existed: true };
  }

  /** 列出本平台沙箱(仅供管理员核对)。 */
  async list() {
    const out = [];
    for await (const sb of this.client.list({ labels: { app: 'forge' } })) {
      out.push({ id: sb.id, labels: sb.labels || {}, state: sb.state, createdAt: sb.createdAt });
    }
    return out;
  }
}

export function sandboxLabels({ projectId, userId } = {}) {
  return { app: 'forge', ...(projectId ? { forge_project_id: projectId } : {}), ...(userId ? { forge_user_id: userId } : {}) };
}

export function isNotFound(error) {
  const status = error?.statusCode ?? error?.status ?? error?.response?.status;
  return status === 404 || /not\s*found|does not exist/i.test(String(error?.message || error));
}
