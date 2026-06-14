# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately rather than opening a public
issue. Use GitHub's **"Report a vulnerability"** button under this repository's
**Security** tab (Security Advisories → Report a vulnerability). This opens a
private channel with the maintainers.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof of concept if possible),
- affected version / commit.

We aim to acknowledge reports within a few days and will coordinate a fix and
disclosure timeline with you.

## Scope

brain-memory is a local, single-tenant memory engine that runs on the user's
own machine with their own API keys. It opens a **read-only** local HTTP server
for the optional visualizer (bound to `127.0.0.1`) and never transmits memory
contents to any third party beyond the model/embedding provider the user
configures. Security-relevant areas include: the local server endpoints, SQL
query construction, prompt/data handling for the model provider seam, and
redaction of secrets before ingestion.

## Supported versions

This project is pre-1.0; security fixes target the latest `main`.
