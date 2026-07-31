#!/bin/sh
echo '{"type":"error","message":"simulated fatal startup error","stack":"at fakeRuntime (error-message.sh:1)"}'
echo 'diagnostic detail on stderr' >&2
exit 1
