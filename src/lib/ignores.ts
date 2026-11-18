// 新建、加入文件夹时生成 .stignore：勾上的写成规则，没勾的留成注释，以后想忽略去掉 // 就行
// 只对这台机器生效：.stignore 本身不会同步
export type IgnoreRule = {
  /** 写进 .stignore 的规则 */
  rule: string
  /** 界面上的行尾说明；.stignore 不支持行尾注释，不写进文件 */
  note: string
}

export type IgnoreItem = {
  id: string
  label: string
  /** 为什么建议忽略，界面右侧面板的说明 */
  description: string
  lines: IgnoreRule[]
  checked: boolean
}

// (?d)：这些文件挡着删除目录时允许一起删掉
export const IGNORE_ITEMS: IgnoreItem[] = [
  {
    id: 'system',
    label: '系统文件',
    description:
      'macOS 自动生成的文件，对别的电脑没有用，同步过去只会变成垃圾。',
    lines: [
      { rule: '(?d).DS_Store', note: '访达记住图标位置、显示方式的文件' },
      { rule: '(?d)._*', note: '非 Mac 格式磁盘上存附加信息的影子文件' },
      { rule: '(?d).Spotlight-V100', note: '聚焦搜索的索引' },
      { rule: '(?d).Trashes', note: '移动硬盘上的废纸篓' },
    ],
    checked: true,
  },
  {
    id: 'temp',
    label: '临时文件',
    description:
      '编辑器和办公软件打开文件时留下的临时文件，关掉就没了；同步过去还可能和别人的冲突。',
    lines: [
      { rule: '(?d)*.tmp', note: '各种程序的临时文件' },
      { rule: '(?d)*.swp', note: 'Vim 等编辑器的交换文件' },
      { rule: '(?d)~$*', note: 'Office 打开文档时生成的锁文件' },
    ],
    checked: true,
  },
  {
    id: 'deps',
    label: '依赖目录',
    description:
      '按项目配置重新安装就有，文件多、体积大，同步很慢；不同系统装出来的还可能不通用。',
    lines: [
      { rule: 'node_modules', note: 'npm / pnpm 装的依赖' },
      { rule: '.venv', note: 'Python 虚拟环境' },
      { rule: '__pycache__', note: 'Python 编译缓存' },
    ],
    checked: false,
  },
  {
    id: 'build',
    label: '构建产物',
    description: '每次构建都会重新生成，每台电脑自己构建就行。',
    lines: [
      { rule: 'dist', note: '前端打包输出' },
      { rule: 'build', note: '常见的构建输出目录' },
      { rule: 'target', note: 'Rust、Java 的构建输出' },
    ],
    checked: false,
  },
  {
    id: 'git',
    label: 'Git 仓库数据',
    description:
      '两台电脑同时改 Git 的内部数据容易把仓库弄坏，代码仓库建议用 Git 自己同步。',
    lines: [{ rule: '.git', note: '提交历史和仓库内部数据' }],
    checked: false,
  },
  {
    id: 'env',
    label: '环境变量文件',
    description: '常放密钥和本机专用的配置，一般不该同步到别的电脑。',
    lines: [
      { rule: '.env', note: '环境变量文件' },
      { rule: '.env.*', note: '.env.local 等变体' },
    ],
    checked: false,
  },
]

export const defaultIgnores = () =>
  IGNORE_ITEMS.filter((i) => i.checked).map((i) => i.id)

/** 自定义规则只保留非空行；Syncthing 的注释必须整行写 //，行尾注释会被当成文件名 */
export function buildIgnores(checked: string[], custom: string) {
  const out = [
    '// FoxSync 生成的忽略规则，只对这台机器生效',
    '// 语法见 https://docs.syncthing.net/users/ignoring.html',
  ]
  for (const item of IGNORE_ITEMS) {
    const on = checked.includes(item.id)
    out.push(
      '',
      `// ${item.label}`,
      ...item.lines.map(({ rule }) => (on ? rule : `// ${rule}`)),
    )
  }
  const lines = custom
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  out.push('', '// 自定义', ...lines)
  return out.join('\n')
}
