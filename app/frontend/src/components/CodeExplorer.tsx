import { useState } from 'react';
import { File as FileIcon } from 'lucide-react';
import type { ProjectFile } from '@/lib/supabase';

/** 文件夹展示 + 只读代码视图。 */
export function CodeExplorer({ files }: { files: ProjectFile[] }) {
  const [active, setActive] = useState<string>(files[0]?.path ?? '');
  const current = files.find((f) => f.path === active) ?? files[0];

  if (files.length === 0) {
    return (
      <div className="h-full grid place-items-center p-6">
        <p className="text-[13px] text-[var(--text-2)] text-center">
          还没有生成代码。Build 执行后,生成的文件会出现在这里。
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex min-h-0">
      <aside className="w-[180px] sm:w-[220px] shrink-0 border-r border-[var(--line)] overflow-auto">
        {files.map((file) => {
          const selected = file.path === current?.path;
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => setActive(file.path)}
              className={`w-full text-left px-3 py-1.5 text-[12.5px] font-mono flex items-center gap-2 border-l-2 ${
                selected ? 'bg-[var(--bg)] border-[var(--accent)] text-[var(--text)]' : 'border-transparent text-[var(--text-2)]'
              }`}
            >
              <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-2)]" />
              <span className="truncate">{file.path}</span>
            </button>
          );
        })}
      </aside>
      <div className="flex-1 min-w-0 overflow-auto">
        <pre className="p-4 text-[12.5px] leading-5 font-mono whitespace-pre">
          {(current?.content ?? '').split('\n').map((line, index) => (
            <div key={index} className="flex">
              <span className="w-10 shrink-0 select-none text-[var(--text-2)] text-right pr-3">{index + 1}</span>
              <span className="flex-1">{line || ' '}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
