#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { installTokenRedaction } from "./redact.ts";
import { XCloudClient } from "./client.ts";
import { buildServer } from "./server.ts";

const { token, baseUrl, destructive } = loadConfig();
installTokenRedaction(token); // egress net: the PAT can never leave the process in cleartext
const server = buildServer(new XCloudClient(token, baseUrl), destructive);
await server.connect(new StdioServerTransport());
