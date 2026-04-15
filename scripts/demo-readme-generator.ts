/**
 * Demo: Decision-tree-driven README generator
 *
 * This script uses the modular-decision-tree-library itself to analyze its own
 * codebase and produce a publishable README.md with architecture docs, API
 * reference, usage examples, and a mermaid diagram.
 *
 * It exercises every node type (Conversation, ToolCall, Conditional, Success,
 * Failure) with real filesystem tool handlers and Gemini Flash Lite making
 * actual decisions at branch points.
 *
 * Usage:
 *   GEMINI_API_KEY=your-key npx tsx scripts/demo-readme-generator.ts
 *
 * Output:
 *   ./generated-README.md   — the produced artifact
 *   ./generated-ARCHITECTURE.md — architecture doc with mermaid diagrams
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DecisionTree } from '../src/core/DecisionTree.js';
import { ConversationNode } from '../src/nodes/ConversationNode.js';
import { ToolCallNode } from '../src/nodes/ToolCallNode.js';
import { ConditionalNode } from '../src/nodes/ConditionalNode.js';
import { SuccessNode } from '../src/nodes/SuccessNode.js';
import { FailureNode } from '../src/nodes/FailureNode.js';
import { PathTracker } from '../src/tracking/PathTracker.js';
import { RecommendationEngine } from '../src/recommendation/RecommendationEngine.js';
import { TreeExecutor } from '../src/execution/TreeExecutor.js';
import { GeminiAdapter } from '../src/adapters/GeminiAdapter.js';
import { TreeSerializer } from '../src/serialization/TreeSerializer.js';
import type { ToolHandler, ExecutionEvents } from '../src/execution/TreeExecutor.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname!, '..');

function readFile(filePath: string): string {
  return fs.readFileSync(path.resolve(ROOT, filePath), 'utf-8');
}

function listDir(dir: string, ext?: string): string[] {
  const full = path.resolve(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full, { recursive: true })
    .map(String)
    .filter((f) => !ext || f.endsWith(ext))
    .sort();
}

function writeOutput(name: string, content: string) {
  const out = path.resolve(ROOT, name);
  fs.writeFileSync(out, content, 'utf-8');
  console.log(`  wrote ${out}`);
}

// ─── Tool Handlers (real filesystem ops) ──────────────────────────────────────

const toolHandlers = new Map<string, ToolHandler>();

// Scans the project and returns a structural overview
toolHandlers.set('scanProject', async () => {
  const pkg = JSON.parse(readFile('package.json'));
  const srcFiles = listDir('src', '.ts').filter((f) => !f.includes('__tests__'));
  const testFiles = listDir('src/__tests__', '.ts');
  const hasTests = testFiles.length > 0;
  const hasTsConfig = fs.existsSync(path.resolve(ROOT, 'tsconfig.json'));

  return {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    dependencies: Object.keys(pkg.dependencies ?? {}),
    devDependencies: Object.keys(pkg.devDependencies ?? {}),
    scripts: pkg.scripts,
    srcFiles,
    testFiles,
    hasTests,
    hasTsConfig,
    totalSrcFiles: srcFiles.length,
    totalTestFiles: testFiles.length,
  };
});

// Reads key source files and extracts interfaces/classes
toolHandlers.set('analyzeInterfaces', async () => {
  const interfaces = readFile('src/core/interfaces.ts');
  const decisionTree = readFile('src/core/DecisionTree.ts');
  const executor = readFile('src/execution/TreeExecutor.ts');
  const adapter = readFile('src/adapters/ILLMDecisionTreeAdapter.ts');
  const gemini = readFile('src/adapters/GeminiAdapter.ts');
  const recommendation = readFile('src/recommendation/RecommendationEngine.ts');
  const serializer = readFile('src/serialization/TreeSerializer.ts');

  // Extract exported interface/class/type names
  const extractExports = (code: string) => {
    const matches = code.matchAll(
      /export\s+(?:interface|class|type|function)\s+(\w+)/g,
    );
    return [...matches].map((m) => m[1]!);
  };

  return {
    coreInterfaces: extractExports(interfaces),
    coreClasses: extractExports(decisionTree),
    executionExports: extractExports(executor),
    adapterInterface: extractExports(adapter),
    geminiExports: extractExports(gemini),
    recommendationExports: extractExports(recommendation),
    serializerExports: extractExports(serializer),
    interfacesSource: interfaces,
    executorSource: executor,
    adapterSource: adapter,
  };
});

// Reads node type implementations
toolHandlers.set('analyzeNodes', async () => {
  const nodeTypes = [
    'ConversationNode',
    'ToolCallNode',
    'ConditionalNode',
    'SuccessNode',
    'FailureNode',
  ];
  const nodes: Record<string, { source: string; dataInterface: string }> = {};
  for (const name of nodeTypes) {
    const source = readFile(`src/nodes/${name}.ts`);
    // Extract the data interface
    const dataMatch = source.match(
      /export interface (\w+Data)\s*\{([^}]+)\}/s,
    );
    nodes[name] = {
      source,
      dataInterface: dataMatch ? `${dataMatch[1]}: {${dataMatch[2]}}` : '',
    };
  }
  return nodes;
});

// Reads test files and extracts describe/it blocks for coverage summary
toolHandlers.set('analyzeTests', async () => {
  const testFiles = listDir('src/__tests__', '.ts');
  const summary: Record<string, string[]> = {};
  for (const file of testFiles) {
    const source = readFile(`src/__tests__/${file}`);
    const its = [...source.matchAll(/it\(['"](.+?)['"]/g)].map((m) => m[1]!);
    summary[file] = its;
  }
  const totalTests = Object.values(summary).flat().length;
  return { summary, totalTests };
});

// Writes the final README
toolHandlers.set('writeReadme', async (params) => {
  const content = params['content'] as string;
  writeOutput('generated-README.md', content);
  return { written: true, path: 'generated-README.md', bytes: content.length };
});

// Writes the architecture doc
toolHandlers.set('writeArchitecture', async (params) => {
  const content = params['content'] as string;
  writeOutput('generated-ARCHITECTURE.md', content);
  return {
    written: true,
    path: 'generated-ARCHITECTURE.md',
    bytes: content.length,
  };
});

// Serializes the tree itself as a demo artifact
toolHandlers.set('serializeTree', async (params) => {
  const treeJson = params['treeJson'] as string;
  writeOutput('generated-tree-definition.json', treeJson);
  return { written: true, path: 'generated-tree-definition.json' };
});

// ─── Condition Evaluators ─────────────────────────────────────────────────────

const conditionEvaluators = new Map<
  string,
  (ctx: { variables: Record<string, unknown> }) => boolean
>();

conditionEvaluators.set('hasTests', (ctx) => {
  const scan = ctx.variables['tool_scanProject'] as
    | { hasTests: boolean }
    | undefined;
  return scan?.hasTests ?? false;
});

conditionEvaluators.set('hasMultipleModules', (ctx) => {
  const scan = ctx.variables['tool_scanProject'] as
    | { totalSrcFiles: number }
    | undefined;
  return (scan?.totalSrcFiles ?? 0) > 5;
});

// ─── Build the Decision Tree ──────────────────────────────────────────────────

function buildTree(): DecisionTree {
  const tree = new DecisionTree();

  // ── Phase 1: Project scanning ───────────────────────────────────────────
  tree.addNode(
    new ConversationNode('start', 'Begin README Generation', {
      prompt:
        'We are generating comprehensive documentation for a TypeScript library. Begin by scanning the project structure.',
    }),
  );

  tree.addNode(
    new ToolCallNode('scan', 'Scan Project Structure', {
      toolName: 'scanProject',
      parameters: {},
    }),
  );

  // ── Phase 2: Conditional — is this worth documenting? ───────────────────
  const checkModules = new ConditionalNode(
    'checkModules',
    'Check if project has multiple modules',
    { condition: 'hasMultipleModules', evaluator: 'hasMultipleModules' },
  );
  checkModules.trueEdgeId = 'e-modules-yes';
  checkModules.falseEdgeId = 'e-modules-no';
  tree.addNode(checkModules);

  tree.addNode(
    new FailureNode('tooSimple', 'Project too simple for full docs', {
      message:
        'Project has fewer than 5 source files. A simple README would suffice.',
      recoverable: true,
      suggestedAction: 'Generate a minimal README instead',
    }),
  );

  // ── Phase 3: Deep analysis ──────────────────────────────────────────────
  tree.addNode(
    new ToolCallNode('analyzeInterfaces', 'Analyze Core Interfaces', {
      toolName: 'analyzeInterfaces',
      parameters: {},
    }),
  );

  tree.addNode(
    new ToolCallNode('analyzeNodes', 'Analyze Node Types', {
      toolName: 'analyzeNodes',
      parameters: {},
    }),
  );

  // ── Phase 4: Check for tests ────────────────────────────────────────────
  const checkTests = new ConditionalNode(
    'checkTests',
    'Check if project has tests',
    { condition: 'hasTests', evaluator: 'hasTests' },
  );
  checkTests.trueEdgeId = 'e-tests-yes';
  checkTests.falseEdgeId = 'e-tests-no';
  tree.addNode(checkTests);

  tree.addNode(
    new ToolCallNode('analyzeTests', 'Analyze Test Coverage', {
      toolName: 'analyzeTests',
      parameters: {},
    }),
  );

  tree.addNode(
    new ConversationNode('skipTests', 'Skip Test Documentation', {
      prompt: 'No tests found. Skip test documentation section.',
    }),
  );

  // ── Phase 5: Decide documentation depth ─────────────────────────────────
  tree.addNode(
    new ConversationNode('decideDepth', 'Choose Documentation Depth', {
      prompt:
        'Based on the analysis, should we generate comprehensive documentation (architecture + API reference + examples) or standard documentation (overview + API reference)? Choose based on the complexity of the codebase.',
      expectedResponses: ['comprehensive', 'standard'],
    }),
  );

  // ── Phase 6a: Comprehensive path — generate architecture doc ────────────
  tree.addNode(
    new ConversationNode('genArchitecture', 'Generate Architecture Document', {
      prompt: `Generate a comprehensive ARCHITECTURE.md document for this TypeScript library. Include:
1. A high-level overview of the system
2. A mermaid diagram showing the module relationships
3. Detailed explanation of each module (core, nodes, tracking, execution, adapters, recommendation, serialization)
4. Data flow description
5. Extension points

Use the analyzed interfaces and source code from the context variables to write accurate, specific documentation. Write in markdown. Do NOT wrap the entire response in a code block — output raw markdown directly.`,
    }),
  );

  tree.addNode(
    new ToolCallNode('writeArchDoc', 'Write Architecture Document', {
      toolName: 'writeArchitecture',
      parameters: { content: '__PLACEHOLDER__' },
    }),
  );

  // ── Phase 6b: Standard path — skip architecture ─────────────────────────
  tree.addNode(
    new ConversationNode('skipArch', 'Skip Architecture Doc', {
      prompt: 'Standard documentation selected. Proceeding to README generation.',
    }),
  );

  // ── Phase 7: Generate README ────────────────────────────────────────────
  tree.addNode(
    new ConversationNode('genReadme', 'Generate README Content', {
      prompt: `Generate a comprehensive, publishable README.md for this TypeScript library. Include:
1. Package name and badges placeholder
2. One-paragraph description of what it does and why it's useful
3. Key features list
4. Installation instructions
5. Quick start example showing: building a tree, adding nodes, running the executor with MockDecisionMaker
6. API reference section covering the main exports (DecisionTree, node types, TreeExecutor, GeminiAdapter, PathTracker, RecommendationEngine, TreeSerializer)
7. Gemini Flash Lite integration section with example
8. Configuration options
9. Testing section (reference the test count from context)
10. License (ISC)

Use the analyzed data from context variables to write accurate documentation. Reference actual interface names and method signatures. Write in markdown. Do NOT wrap the entire response in a code block — output raw markdown directly.`,
    }),
  );

  tree.addNode(
    new ToolCallNode('writeReadmeFile', 'Write README File', {
      toolName: 'writeReadme',
      parameters: { content: '__PLACEHOLDER__' },
    }),
  );

  // ── Phase 8: Serialize the tree as a bonus artifact ─────────────────────
  tree.addNode(
    new ToolCallNode('serializeTree', 'Serialize This Tree', {
      toolName: 'serializeTree',
      parameters: { treeJson: '__PLACEHOLDER__' },
    }),
  );

  // ── Terminal nodes ──────────────────────────────────────────────────────
  tree.addNode(
    new SuccessNode('done', 'Documentation Complete', {
      message: 'All documentation artifacts generated successfully.',
      resultData: {
        artifacts: [
          'generated-README.md',
          'generated-ARCHITECTURE.md',
          'generated-tree-definition.json',
        ],
      },
    }),
  );

  // ── Edges ───────────────────────────────────────────────────────────────

  // Phase 1 → 2
  tree.addEdge({
    id: 'e-start-scan',
    sourceId: 'start',
    targetId: 'scan',
    metadata: {},
  });
  tree.addEdge({
    id: 'e-scan-check',
    sourceId: 'scan',
    targetId: 'checkModules',
    metadata: {},
  });

  // Phase 2 conditional
  tree.addEdge({
    id: 'e-modules-yes',
    sourceId: 'checkModules',
    targetId: 'analyzeInterfaces',
    condition: 'Has multiple modules',
    metadata: {},
  });
  tree.addEdge({
    id: 'e-modules-no',
    sourceId: 'checkModules',
    targetId: 'tooSimple',
    condition: 'Too few files',
    metadata: {},
  });

  // Phase 3 chain
  tree.addEdge({
    id: 'e-interfaces-nodes',
    sourceId: 'analyzeInterfaces',
    targetId: 'analyzeNodes',
    metadata: {},
  });
  tree.addEdge({
    id: 'e-nodes-checkTests',
    sourceId: 'analyzeNodes',
    targetId: 'checkTests',
    metadata: {},
  });

  // Phase 4 conditional
  tree.addEdge({
    id: 'e-tests-yes',
    sourceId: 'checkTests',
    targetId: 'analyzeTests',
    condition: 'Has tests',
    metadata: {},
  });
  tree.addEdge({
    id: 'e-tests-no',
    sourceId: 'checkTests',
    targetId: 'skipTests',
    condition: 'No tests',
    metadata: {},
  });

  // Converge to depth decision
  tree.addEdge({
    id: 'e-tests-depth',
    sourceId: 'analyzeTests',
    targetId: 'decideDepth',
    metadata: {},
  });
  tree.addEdge({
    id: 'e-skipTests-depth',
    sourceId: 'skipTests',
    targetId: 'decideDepth',
    metadata: {},
  });

  // Phase 5 → 6a or 6b
  tree.addEdge({
    id: 'e-depth-comprehensive',
    sourceId: 'decideDepth',
    targetId: 'genArchitecture',
    condition: 'comprehensive',
    metadata: {},
    weight: 0.7,
  });
  tree.addEdge({
    id: 'e-depth-standard',
    sourceId: 'decideDepth',
    targetId: 'skipArch',
    condition: 'standard',
    metadata: {},
    weight: 0.3,
  });

  // Phase 6a chain
  tree.addEdge({
    id: 'e-arch-writeArch',
    sourceId: 'genArchitecture',
    targetId: 'writeArchDoc',
    metadata: {},
  });
  tree.addEdge({
    id: 'e-writeArch-readme',
    sourceId: 'writeArchDoc',
    targetId: 'genReadme',
    metadata: {},
  });

  // Phase 6b → README
  tree.addEdge({
    id: 'e-skipArch-readme',
    sourceId: 'skipArch',
    targetId: 'genReadme',
    metadata: {},
  });

  // Phase 7 → write
  tree.addEdge({
    id: 'e-readme-write',
    sourceId: 'genReadme',
    targetId: 'writeReadmeFile',
    metadata: {},
  });

  // Phase 8 → serialize → done
  tree.addEdge({
    id: 'e-write-serialize',
    sourceId: 'writeReadmeFile',
    targetId: 'serializeTree',
    metadata: {},
  });
  tree.addEdge({
    id: 'e-serialize-done',
    sourceId: 'serializeTree',
    targetId: 'done',
    metadata: {},
  });

  return tree;
}

// ─── Content generation ───────────────────────────────────────────────────────
// Content is generated inside the write tool handlers themselves (which are
// async and properly awaited by the executor), ensuring the content is ready
// before being written to disk.

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env['GEMINI_API_KEY'];

  if (!apiKey) {
    console.error(
      'Error: GEMINI_API_KEY environment variable is required.\n' +
        'Usage: GEMINI_API_KEY=your-key npx tsx scripts/demo-readme-generator.ts',
    );
    process.exit(1);
  }

  console.log('=== Decision Tree README Generator ===\n');

  // Build the tree
  console.log('1. Building decision tree...');
  const tree = buildTree();
  console.log(
    `   ${tree.nodeCount} nodes, ${tree.edgeCount} edges\n`,
  );

  // Set up Gemini
  console.log('2. Initializing Gemini Flash Lite...');
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash-lite',
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
  });

  const geminiAdapter = new GeminiAdapter({
    apiKey,
    modelName: 'gemini-2.0-flash-lite',
    maxRetries: 3,
    retryDelayMs: 1000,
    maxOutputTokens: 100,
  });

  // Set up tracking
  const tracker = new PathTracker();

  // Wrap tool handlers — the write handlers generate content via Gemini first
  const wrappedToolHandlers = new Map(toolHandlers);

  // Helper to get accumulated variables from the executor's context
  // We'll capture them from onStepStart events
  let latestVariables: Record<string, unknown> = {};

  const archPrompt = (
    tree.getNode('genArchitecture') as { data?: { prompt?: string } }
  ).data?.prompt ?? '';
  const readmePrompt = (
    tree.getNode('genReadme') as { data?: { prompt?: string } }
  ).data?.prompt ?? '';

  // Strip wrapping code fences that Gemini sometimes adds
  function stripCodeFences(text: string): string {
    let s = text.trim();
    if (s.startsWith('```markdown')) s = s.slice('```markdown'.length);
    else if (s.startsWith('```md')) s = s.slice('```md'.length);
    else if (s.startsWith('```')) s = s.slice(3);
    if (s.endsWith('```')) s = s.slice(0, -3);
    return s.trim();
  }

  wrappedToolHandlers.set('writeArchitecture', async () => {
    console.log('  [Gemini] Generating architecture doc...');
    const fullPrompt = `${archPrompt}\n\nProject data:\n${JSON.stringify(latestVariables, null, 2).slice(0, 15000)}`;
    const result = await geminiModel.generateContent(fullPrompt);
    const content = stripCodeFences(result.response.text());
    console.log(`  [Gemini] Generated ${content.length} chars`);
    writeOutput('generated-ARCHITECTURE.md', content);
    return { written: true, path: 'generated-ARCHITECTURE.md', bytes: content.length };
  });

  wrappedToolHandlers.set('writeReadme', async () => {
    console.log('  [Gemini] Generating README...');
    const fullPrompt = `${readmePrompt}\n\nProject data:\n${JSON.stringify(latestVariables, null, 2).slice(0, 15000)}`;
    const result = await geminiModel.generateContent(fullPrompt);
    const content = stripCodeFences(result.response.text());
    console.log(`  [Gemini] Generated ${content.length} chars`);
    writeOutput('generated-README.md', content);
    return { written: true, path: 'generated-README.md', bytes: content.length };
  });

  // Serialize the tree itself for the serialize step
  const serializer = new TreeSerializer();
  const treeJson = serializer.toJSON(tree);
  wrappedToolHandlers.set('serializeTree', async () => {
    writeOutput('generated-tree-definition.json', treeJson);
    return { written: true, path: 'generated-tree-definition.json' };
  });

  // Set up events for logging + capturing variables
  const events: ExecutionEvents = {
    onStepStart: (ctx, node) => {
      console.log(
        `  [Step ${ctx.stepCount + 1}] Entering: ${node.label} (${node.type}) [${node.id}]`,
      );
      latestVariables = ctx.variables;
    },
    onToolCall: (nodeId, toolName, result) => {
      const preview =
        typeof result === 'object'
          ? JSON.stringify(result).slice(0, 100) + '...'
          : String(result);
      console.log(`  [Tool] ${toolName} -> ${preview}`);
    },
    onConditionEvaluated: (nodeId, condition, result) => {
      console.log(
        `  [Condition] ${condition} = ${result}`,
      );
    },
    onComplete: (result) => {
      console.log(
        `\n  [Complete] Status: ${result.status}, Steps: ${result.stepCount}`,
      );
      console.log(`  [Path] ${result.pathTaken.join(' -> ')}`);
    },
    onError: (_ctx, error) => {
      console.error(`  [Error] ${error.message}`);
    },
  };

  // Create executor
  console.log('3. Starting execution...\n');
  const executor = new TreeExecutor(
    tree,
    geminiAdapter,
    tracker,
    {
      maxSteps: 30,
      toolHandlers: wrappedToolHandlers,
      conditionEvaluators: conditionEvaluators as Map<
        string,
        (ctx: { variables: Record<string, unknown> }) => boolean
      >,
    },
    events,
  );

  const result = await executor.execute('start');

  // ── Post-execution analytics ────────────────────────────────────────────
  console.log('\n4. Post-execution analytics:\n');

  const recommendation = new RecommendationEngine(tree, tracker);
  const analysis = recommendation.analyzeHistory();
  console.log(`   Sessions: ${analysis.totalSessions}`);
  console.log(`   Success rate: ${(analysis.successRate * 100).toFixed(1)}%`);
  console.log(`   Avg path length: ${analysis.averagePathLength.toFixed(1)}`);
  console.log(`   Most common path: ${analysis.mostCommonPath.join(' -> ')}`);

  const bottlenecks = recommendation.identifyBottlenecks();
  if (bottlenecks.length > 0) {
    console.log(`   Bottleneck nodes: ${bottlenecks.map((b) => b.nodeId).join(', ')}`);
  } else {
    console.log('   No bottleneck nodes detected');
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('\n=== Done ===\n');
  if (result.status === 'success') {
    console.log('Generated artifacts:');
    console.log('  - generated-README.md');
    console.log('  - generated-ARCHITECTURE.md');
    console.log('  - generated-tree-definition.json');
    console.log(
      '\nThese files demonstrate the library generating real documentation',
    );
    console.log(
      'by orchestrating Gemini Flash Lite through a decision tree.',
    );
  } else {
    console.log(`Execution ended with status: ${result.status}`);
    if (result.error) console.log(`Error: ${result.error}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
