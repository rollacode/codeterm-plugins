The recorded-edit fixture was captured offline from installed aider-chat 0.86.2.
Its real InputOutput wrote a controlled user input, SEARCH/REPLACE response and
applied-edit notice. Its real GitRepo.commit, called with aider_edits=True and an
explicit message, committed the changed sample.txt and wrote the commit notice.
No model or network was used. The patch is git show's output for that exact
commit, not a reconstruction from SEARCH text. The fixture is a protocol capture
with controlled content, not a live model transcript.

The bundle test supplies the recorded Git output through host.exec. It checks
the immutable commit argv, the expected FileDiff list, split deltas and rejection
when the commit, repository, or applied-edit evidence is unavailable. This path
intentionally emits no speculative diffs for --no-auto-commits or --no-git.
