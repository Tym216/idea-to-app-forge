/**
 * Daytona 冒烟测试(显式运行,不属于默认测试):npm run smoke:daytona
 * 创建测试沙箱 → echo → 写入并读回文件 → finally 清理沙箱。
 */
import './env.js';

const key = (process.env.DAYTONA_API_KEY || '').trim();
const mask = (v) => (!v ? '(空)' : v.length <= 8 ? '****' : `${v.slice(0, 4)}****${v.slice(-4)}`);
let failures = 0;
const ok = (msg) => console.log(`✅ ${msg}`);
const bad = (msg, error) => {
  failures += 1;
  console.log(`❌ ${msg}${error ? `\n   → ${String(error?.message || error).slice(0, 500)}` : ''}`);
};

export async function runSmoke() {
  console.log('Daytona 冒烟测试');
  console.log(`   DAYTONA_API_URL = ${process.env.DAYTONA_API_URL || 'https://app.daytona.io/api(默认)'}`);
  console.log(`   DAYTONA_API_KEY = ${mask(key)}`);
  if (!key) {
    bad('DAYTONA_API_KEY 未配置,未执行冒烟测试', '在 app/worker/.env 填写后重试');
    return 1;
  }

  const { DaytonaProvider } = await import('./sandbox/daytona.js');
  let provider;
  let sandboxId;
  try {
    provider = new DaytonaProvider();
    const started = Date.now();
    const projectId = process.env.SMOKE_PROJECT_ID, userId = process.env.SMOKE_USER_ID;
    if (!projectId || !userId) throw new Error('Explicit SMOKE_PROJECT_ID / SMOKE_USER_ID required');
    ({ sandboxId } = await provider.create({ projectId, userId }));
    ok(`创建测试沙箱 ${sandboxId}(${Date.now() - started}ms),工作目录 ${provider.workdir}`);

    const echo = await provider.exec(sandboxId, 'echo forge-smoke-ok', { timeoutMs: 60000 });
    if (echo.exitCode === 0 && echo.stdout.trim() === 'forge-smoke-ok') ok(`执行 echo:exitCode=0 输出="${echo.stdout.trim()}"`);
    else bad(`执行 echo 结果不符:exitCode=${echo.exitCode} 输出=${JSON.stringify(echo.stdout)} ${echo.stderr}`);

    const content = `中文与 emoji ✓ ${new Date().toISOString()}\n第二行`;
    await provider.writeFile(sandboxId, 'smoke/hello.txt', content);
    ok('写入文件 smoke/hello.txt');
    const read = await provider.readFile(sandboxId, 'smoke/hello.txt');
    if (read === content) ok('读回文件内容一致');
    else bad(`读回内容不一致:${JSON.stringify(read.slice(0, 100))}`);

    const files = await provider.listFiles(sandboxId);
    if (files.includes('smoke/hello.txt')) ok(`列目录包含 smoke/hello.txt(共 ${files.length} 个文件)`);
    else bad(`列目录未找到测试文件:${JSON.stringify(files.slice(0, 10))}`);
  } catch (error) {
    bad('冒烟测试步骤异常', error);
  } finally {
    if (provider && sandboxId) {
      try {
        await provider.destroy(sandboxId);
        ok(`已清理测试沙箱 ${sandboxId}`);
      } catch (error) {
        bad(`清理测试沙箱 ${sandboxId} 失败,请到 Daytona 控制台手动删除`, error);
      }
    }
  }
  console.log(failures === 0 ? '\n冒烟测试全部通过' : `\n冒烟测试有 ${failures} 项失败`);
  return failures === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSmoke().then((code) => {
    process.exitCode = code;
  });
}
