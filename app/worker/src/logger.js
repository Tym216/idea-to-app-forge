/** 结构化日志,带请求/任务上下文。 */
const write = (level, message, context = {}) => {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, message, ...context })}\n`
  );
};

export const logger = {
  info: (message, context) => write('info', message, context),
  warn: (message, context) => write('warn', message, context),
  error: (message, context) => write('error', message, context),
};
