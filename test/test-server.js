import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';

const userApiKey = process.env.GEMINI_API_KEY;

async function runTest() {
  if (!userApiKey) {
    console.error('GEMINI_API_KEY belum diset. Jalankan: GEMINI_API_KEY=xxx node test/test-server.js');
    process.exit(1);
  }
  console.log('--- Starting MCP Vision Server Smoke Test ---');

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['./src/server.js'],
    env: {
      ...process.env,
      GEMINI_API_KEY: userApiKey,
    },
  });

  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('✓ Connected to MCP server via stdio');

  // 1. List tools
  const tools = await client.listTools();
  console.log('✓ Tools returned by server:', tools.tools.map((t) => t.name));

  // 2. Call analyze_image with real sample image
  const sampleImagePath = path.resolve('test/sample.png');
  console.log(`✓ Calling analyze_image on: ${sampleImagePath}...`);

  const result = await client.callTool({
    name: 'analyze_image',
    arguments: {
      image_path: sampleImagePath,
      prompt: 'Deskripsikan warna dan isi gambar ini secara singkat.',
    },
  });

  console.log('✓ Response from analyze_image tool:');
  console.log(JSON.stringify(result, null, 2));

  await client.close();
  console.log('--- MCP Vision Server Smoke Test Finished ---');
}

runTest().catch((err) => {
  console.error('Test Failed:', err);
  process.exit(1);
});
