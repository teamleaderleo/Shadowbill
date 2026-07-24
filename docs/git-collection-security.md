# Git collection security

Shadowbill's post-commit hook runs the local CLI after a commit and records aggregate diff statistics.

## Hook command quoting

Every generated shell argument uses POSIX single-quote escaping. Repository and CLI paths containing spaces, quotes, dollar signs, backticks, or command substitutions remain literal arguments.

The hook invokes the absolute Node executable from `process.execPath`. It does not resolve a replacement `node` binary through the hook process's `PATH`.

Existing POSIX shell hooks are preserved, and the Shadowbill command is appended once. Hooks with unsupported interpreters are rejected instead of being rewritten.

## Repository identifiers

Remote URLs are reduced to a content-minimized identifier:

- GitHub remotes become `owner/repository`
- other network remotes become `host/path/to/repository`
- local-path and `file:` remotes fall back to the local repository directory name

Usernames, passwords, tokens, query strings, fragments, transport schemes, and network ports are discarded before the repository value enters the ledger.

Supported network forms include HTTPS URLs, SSH URLs, and Git's SCP-style syntax such as `git@example.com:group/repository.git`.
