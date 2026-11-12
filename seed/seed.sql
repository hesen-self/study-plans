-- 八大领域知识图谱种子数据（48 节点）
-- domain: ai-ml | backend | frontend | data | devops | cs-basic | security | product
-- level: 1入门 2进阶 3高级 | status: todo | learning | done
-- 领域为学科粗分，交叉方向用 tags 二级细分 + related 边表达

INSERT INTO nodes (id, name, domain, level, status, progress, tags) VALUES
-- ============ 后端开发 backend ============
('java-basics',      'Java 基础',        'backend', 1, 'todo', 0, '["java","语法","面向对象"]'),
('java-advanced',    'Java 进阶',        'backend', 2, 'todo', 0, '["java","集合","并发","JVM"]'),
('spring-core',      'Spring Core',      'backend', 2, 'todo', 0, '["java","IoC","AOP"]'),
('spring-boot',      'Spring Boot',      'backend', 2, 'todo', 0, '["java","自动配置","Web"]'),
('spring-data-jpa',  'Spring Data JPA',  'backend', 2, 'todo', 0, '["java","ORM","data"]'),
('node-basics',      'Node.js 基础',      'backend', 2, 'todo', 0, '["node","运行时","npm"]'),
('message-queue',    '消息队列',          'backend', 3, 'todo', 0, '["Kafka","RocketMQ"]'),
('distributed-systems','分布式系统',      'backend', 3, 'todo', 0, '["CAP","一致性"]'),
('system-design',    '系统设计',          'backend', 3, 'todo', 0, '["架构","高可用"]'),
-- ============ AI / 机器学习 ai-ml ============
('llm-foundations',  '大模型基础',        'ai-ml', 1, 'todo', 0, '["LLM","预训练"]'),
('transformer-arch', 'Transformer 架构',  'ai-ml', 2, 'todo', 0, '["注意力机制"]'),
('prompt-engineering','Prompt 工程',      'ai-ml', 1, 'todo', 0, '["提示词","Few-shot"]'),
('function-calling', 'Function Calling', 'ai-ml', 2, 'todo', 0, '["工具调用","JSON Schema"]'),
('embedding-theory', 'Embedding 原理',    'ai-ml', 2, 'todo', 0, '["向量化","语义表示"]'),
('rag-theory',       'RAG 原理',         'ai-ml', 2, 'todo', 0, '["检索增强生成"]'),
('mcp-protocol',     'MCP 协议',         'ai-ml', 2, 'todo', 0, '["Model Context Protocol"]'),
('agent-patterns',   'Agent 设计模式',    'ai-ml', 3, 'todo', 0, '["ReAct","规划","反思"]'),
('spring-ai',        'Spring AI',        'ai-ml', 2, 'todo', 0, '["java","spring","LLM","RAG"]'),
('langchain4j',      'LangChain4j',      'ai-ml', 2, 'todo', 0, '["java","LLM 编排","Agent"]'),
('rag-engineering',  'RAG 工程实践',      'ai-ml', 3, 'todo', 0, '["java","检索增强","分块","重排"]'),
('agent-java',       'Java Agent 开发',   'ai-ml', 3, 'todo', 0, '["java","工具调用","多智能体"]'),
('llm-finetune-java','Java 生态微调集成',  'ai-ml', 3, 'todo', 0, '["java","LoRA","模型服务"]'),
('finetuning',       '模型微调',          'ai-ml', 3, 'todo', 0, '["SFT","LoRA","RLHF"]'),
('eval-llm',         'LLM 评估',         'ai-ml', 3, 'todo', 0, '["基准测试","幻觉检测"]'),
('embodied-ai',      '具身智能',          'ai-ml', 3, 'todo', 0, '["机器人","VLA"]'),
-- ============ 前端开发 frontend ============
('html-css',         'HTML/CSS',         'frontend', 1, 'todo', 0, '["布局","选择器"]'),
('javascript',       'JavaScript',       'frontend', 1, 'todo', 0, '["ES6+","异步"]'),
('typescript',       'TypeScript',       'frontend', 1, 'todo', 0, '["类型系统"]'),
('react',            'React',            'frontend', 2, 'todo', 0, '["Hooks","组件化"]'),
('react-ecosystem',  'React 生态',        'frontend', 2, 'todo', 0, '["Router","状态管理"]'),
('vite-toolchain',   'Vite 工程化',       'frontend', 1, 'todo', 0, '["构建","HMR","build"]'),
('css-engineering',  'CSS 工程化',        'frontend', 2, 'todo', 0, '["Tailwind","响应式"]'),
('dataviz',          '数据可视化',        'frontend', 2, 'todo', 0, '["G6","ECharts","D3"]'),
('browser-network',  '浏览器与网络',       'frontend', 2, 'todo', 0, '["HTTP","缓存","渲染"]'),
('web-performance',  'Web 性能优化',      'frontend', 3, 'todo', 0, '["加载","渲染性能"]'),
('testing-frontend', '前端测试',          'frontend', 3, 'todo', 0, '["Vitest","Playwright"]'),
-- ============ 数据与数据库 data ============
('database-theory',  '数据库原理',        'data', 2, 'todo', 0, '["索引","事务","范式"]'),
('sql-practice',     'SQL 实践',         'data', 1, 'todo', 0, '["查询","聚合"]'),
('redis-cache',      'Redis 缓存',        'data', 2, 'todo', 0, '["cache","缓存","数据结构"]'),
('vector-db',        '向量数据库',        'data', 2, 'todo', 0, '["Milvus","pgvector","llm","rag"]'),
-- ============ 工程与运维 devops ============
('maven-gradle',     'Maven/Gradle',     'devops', 1, 'todo', 0, '["构建工具","java"]'),
('git-workflow',     'Git 工作流',        'devops', 1, 'todo', 0, '["分支","协作"]'),
('linux-cli',        'Linux 命令行',      'devops', 1, 'todo', 0, '["Shell","运维"]'),
-- ============ 计算机基础 cs-basic ============
('data-structures',  '数据结构',          'cs-basic', 1, 'todo', 0, '["链表","树","图"]'),
('algorithms',       '算法',             'cs-basic', 2, 'todo', 0, '["排序","动态规划"]'),
('os-basics',        '操作系统',          'cs-basic', 2, 'todo', 0, '["进程","内存"]'),
('network-basics',   '计算机网络',        'cs-basic', 2, 'todo', 0, '["TCP/IP","HTTP"]'),
-- ============ 安全 security ============
('ai-safety',        'AI 安全与对齐',     'security', 2, 'todo', 0, '["llm","对齐","护栏"]');

-- ============ 关系边（prerequisite 前置 | related 相关 | extend 扩展）============
INSERT INTO edges (source, target, type) VALUES
-- 后端主线
('java-basics','java-advanced','prerequisite'),
('java-advanced','spring-core','prerequisite'),
('spring-core','spring-boot','prerequisite'),
('spring-boot','spring-data-jpa','prerequisite'),
('sql-practice','spring-data-jpa','related'),
-- AI 主线
('llm-foundations','transformer-arch','prerequisite'),
('llm-foundations','prompt-engineering','prerequisite'),
('prompt-engineering','function-calling','prerequisite'),
('transformer-arch','embedding-theory','prerequisite'),
('embedding-theory','rag-theory','prerequisite'),
('function-calling','mcp-protocol','prerequisite'),
('rag-theory','agent-patterns','prerequisite'),
('mcp-protocol','agent-patterns','related'),
('llm-foundations','finetuning','extend'),
('finetuning','eval-llm','prerequisite'),
('agent-patterns','embodied-ai','extend'),
-- Java + AI 交叉（backend/ai-ml 跨域，用 related 边表达）
('java-advanced','langchain4j','prerequisite'),
('spring-boot','spring-ai','prerequisite'),
('langchain4j','rag-engineering','related'),
('spring-ai','rag-engineering','prerequisite'),
('vector-db','rag-engineering','prerequisite'),
('embedding-theory','vector-db','related'),
('rag-theory','rag-engineering','related'),
('rag-engineering','agent-java','prerequisite'),
('langchain4j','agent-java','prerequisite'),
('spring-ai','llm-finetune-java','extend'),
('agent-patterns','agent-java','related'),
('prompt-engineering','spring-ai','related'),
('finetuning','llm-finetune-java','related'),
-- 前端主线
('html-css','javascript','prerequisite'),
('javascript','typescript','prerequisite'),
('javascript','react','prerequisite'),
('typescript','react','prerequisite'),
('react','react-ecosystem','prerequisite'),
('react','vite-toolchain','related'),
('html-css','css-engineering','prerequisite'),
('javascript','dataviz','prerequisite'),
('browser-network','web-performance','prerequisite'),
('react-ecosystem','web-performance','related'),
('node-basics','testing-frontend','extend'),
-- 数据
('database-theory','sql-practice','prerequisite'),
('database-theory','redis-cache','prerequisite'),
('redis-cache','message-queue','prerequisite'),
-- 工程
('git-workflow','maven-gradle','related'),
('os-basics','linux-cli','related'),
-- 计基
('data-structures','algorithms','prerequisite'),
('os-basics','distributed-systems','prerequisite'),
('network-basics','distributed-systems','prerequisite'),
('network-basics','browser-network','related'),
('distributed-systems','system-design','prerequisite'),
('algorithms','system-design','related'),
-- 安全
('llm-foundations','ai-safety','extend');

-- ============ 预置学习路线 ============
INSERT INTO roadmaps (id, name, description) VALUES
('java-ai-path', 'Java AI 进阶路线', '从 Java 基础到 Spring AI / LangChain4j，再到 RAG 与 Agent 实战'),
('ai-general-path', 'AI 通用进阶路线', '大模型原理 → Prompt → RAG → Agent → 微调与评估');

INSERT INTO roadmap_steps (roadmap_id, node_id, seq) VALUES
('java-ai-path','java-basics',1),
('java-ai-path','maven-gradle',2),
('java-ai-path','spring-core',3),
('java-ai-path','spring-boot',4),
('java-ai-path','spring-data-jpa',5),
('java-ai-path','spring-ai',6),
('java-ai-path','langchain4j',7),
('java-ai-path','embedding-theory',8),
('java-ai-path','vector-db',9),
('java-ai-path','rag-engineering',10),
('java-ai-path','agent-java',11),
('ai-general-path','llm-foundations',1),
('ai-general-path','prompt-engineering',2),
('ai-general-path','transformer-arch',3),
('ai-general-path','function-calling',4),
('ai-general-path','embedding-theory',5),
('ai-general-path','rag-theory',6),
('ai-general-path','mcp-protocol',7),
('ai-general-path','agent-patterns',8),
('ai-general-path','eval-llm',9),
('ai-general-path','finetuning',10);
