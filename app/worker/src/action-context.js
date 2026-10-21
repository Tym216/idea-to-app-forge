/** Planning view only. Canonical files and the Build context are never replaced. */
export function buildActionContext({task,project,files,memoryText='',instructions=[]}) {
  const lines=[];let used=0,omitted=0;
  for(const file of [...files].sort((a,b)=>a.path.localeCompare(b.path))) {
    const exports=[...file.content.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|interface|type)\s+([A-Za-z_$][\w$]*)/g)].map(m=>m[1]).slice(0,12);
    const testIds=[...file.content.matchAll(/data-testid=["']([^"']{1,80})["']/g)].map(m=>m[1]).slice(0,12);
    const line=JSON.stringify({path:file.path,chars:file.content.length,...(exports.length?{exports}:{}),...(testIds.length?{testIds}: {})});
    if(used+line.length>6000){omitted++;continue;}lines.push(line);used+=line.length+1;
  }
  const index=lines.join('\n')+(omitted?`\n（另有 ${omitted} 个文件未列入本次规划视图；开发时仍可完整列出和读取）`:'');
  const text=[`项目名称: ${project.name}`,`项目已确认需求: ${project.description||'(暂无)'}`,memoryText,...instructions,
    '【已有源码索引：仅供轻量行动规划，不是完整源码。Build 将获得现有源码并可继续读取。】',index,
    '仅规划本轮改动及其验收；复用已知选择器。必要的代码确认写入开发步骤，不猜测未展示的内部实现。',
    `本轮用户需求:\n${task.prompt}`].join('\n\n');
  return {text,parts:{memory:memoryText.length,initial_code:index.length},sourceChars:files.reduce((n,f)=>n+f.content.length,0),indexChars:index.length};
}
