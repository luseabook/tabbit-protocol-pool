#!/usr/bin/env node
import { runProtocolPoolCli } from "../src/ops-cli.js";

const result = await runProtocolPoolCli(process.argv.slice(2));
process.exitCode = result.exitCode;
