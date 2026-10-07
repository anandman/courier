#!/usr/bin/env node
/**
 * The `courier` executable.
 *
 * Kept separate from main.ts so that main.ts can be imported -- by tests, and
 * by anything that wants to call `run` directly -- without a module import
 * launching a command as a side effect.
 */

import { run } from './main.js';
import { CliError, EXIT, type ExitCode } from './exit.js';

run(process.argv.slice(2))
    .then((code) => {
        process.exitCode = code;
    })
    .catch((error) => {
        if (error instanceof CliError) {
            process.stderr.write(`courier: ${error.message}\n`);
            if (error.hint) process.stderr.write(`${error.hint}\n`);
            process.exitCode = error.code;
            return;
        }

        // Unclassified: report it as a CLI defect rather than borrowing a code
        // that would send the caller to fix the wrong thing.
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        process.stderr.write(`courier: unexpected failure\n${message}\n`);
        process.exitCode = EXIT.INTERNAL as ExitCode;
    });
