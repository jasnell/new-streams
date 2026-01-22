/**
 * Analyze a Node.js CPU profile and show top functions
 */

import { readFileSync } from 'node:fs';

interface ProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  hitCount: number;
  children?: number[];
  positionTicks?: { line: number; ticks: number }[];
}

interface Profile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

// Read profile
const profile: Profile = JSON.parse(readFileSync('profile.cpuprofile', 'utf-8'));

// Build node map
const nodeMap = new Map<number, ProfileNode>();
for (const node of profile.nodes) {
  nodeMap.set(node.id, node);
}

// Calculate self time from samples
const selfTime = new Map<number, number>();
for (let i = 0; i < profile.samples.length; i++) {
  const nodeId = profile.samples[i];
  const delta = profile.timeDeltas[i];
  selfTime.set(nodeId, (selfTime.get(nodeId) || 0) + delta);
}

// Calculate total time (self + children)
function calculateTotalTime(nodeId: number, visited = new Set<number>()): number {
  if (visited.has(nodeId)) return 0;
  visited.add(nodeId);
  
  const node = nodeMap.get(nodeId);
  if (!node) return 0;
  
  let total = selfTime.get(nodeId) || 0;
  for (const childId of node.children || []) {
    total += calculateTotalTime(childId, visited);
  }
  return total;
}

// Aggregate by function name and URL
interface FunctionStats {
  name: string;
  url: string;
  selfTime: number;
  lineNumber: number;
}

const functionStats = new Map<string, FunctionStats>();

for (const [nodeId, time] of selfTime) {
  const node = nodeMap.get(nodeId);
  if (!node) continue;
  
  const key = `${node.callFrame.functionName}@${node.callFrame.url}:${node.callFrame.lineNumber}`;
  const existing = functionStats.get(key);
  
  if (existing) {
    existing.selfTime += time;
  } else {
    functionStats.set(key, {
      name: node.callFrame.functionName || '(anonymous)',
      url: node.callFrame.url,
      selfTime: time,
      lineNumber: node.callFrame.lineNumber,
    });
  }
}

// Sort by self time
const sorted = Array.from(functionStats.values())
  .sort((a, b) => b.selfTime - a.selfTime);

// Total time
const totalTime = profile.endTime - profile.startTime;
const totalMicroseconds = Array.from(selfTime.values()).reduce((a, b) => a + b, 0);

console.log('CPU Profile Analysis');
console.log('====================');
console.log(`Total profile time: ${(totalTime / 1000).toFixed(2)}ms`);
console.log(`Total sampled time: ${(totalMicroseconds / 1000).toFixed(2)}ms`);
console.log(`Number of samples: ${profile.samples.length}`);
console.log('');

// Filter to show only our code and interesting functions
const ourCode = sorted.filter(f => 
  f.url.includes('/new-streams/') || 
  f.name.includes('Promise') ||
  f.name.includes('async') ||
  f.name.includes('generator') ||
  f.name.includes('iterate')
);

console.log('Top Functions (by self time):');
console.log('=============================');

// Show top 30
for (let i = 0; i < Math.min(30, sorted.length); i++) {
  const f = sorted[i];
  const percent = (f.selfTime / totalMicroseconds * 100).toFixed(1);
  const selfMs = (f.selfTime / 1000).toFixed(2);
  
  // Shorten the URL for readability
  let location = f.url;
  if (location.includes('/new-streams/')) {
    location = location.split('/new-streams/')[1];
  }
  if (location.startsWith('node:')) {
    location = location.substring(5);
  }
  
  console.log(`${percent.padStart(5)}%  ${selfMs.padStart(8)}ms  ${f.name.padEnd(40).substring(0, 40)}  ${location}:${f.lineNumber}`);
}

console.log('');
console.log('Our Code Only:');
console.log('==============');

for (let i = 0; i < Math.min(20, ourCode.length); i++) {
  const f = ourCode[i];
  const percent = (f.selfTime / totalMicroseconds * 100).toFixed(1);
  const selfMs = (f.selfTime / 1000).toFixed(2);
  
  let location = f.url;
  if (location.includes('/new-streams/')) {
    location = location.split('/new-streams/')[1];
  }
  
  console.log(`${percent.padStart(5)}%  ${selfMs.padStart(8)}ms  ${f.name.padEnd(40).substring(0, 40)}  ${location}:${f.lineNumber}`);
}
