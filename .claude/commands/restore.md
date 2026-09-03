---
description: Put the page back the way it was before this session
allowed-tools: Bash(node scripts/page.mjs:*), Read
---

Undo everything this session did to the page.

1. Use the `pageId` from `/start` earlier in this conversation.
2. Tell the user in one or two sentences what will be lost — everything built or
   changed since the snapshot, whether by you or by them in the builder.
3. Run `node scripts/page.mjs restore --page <pageId>` and let its own prompt
   take their answer. **Do not pass `--yes`.**
4. Report what it says came back.

**This is the only per-page undo that exists.** The platform's own version
history restores the whole app, not one page.

The session stays open afterwards, so they can try again against the same
snapshot.
