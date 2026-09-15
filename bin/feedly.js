#!/usr/bin/env node
import { run } from '../src/cli.js';

for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error) => {
        if (error?.code === 'EPIPE') process.exit(0);
        throw error;
    });
}

process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
});
