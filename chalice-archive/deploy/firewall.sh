#!/bin/sh
# Lets HTTPS (443) in only from Cloudflare, keeps SSH open, and closes every other incoming port. Uses ufw.
#
#   sudo sh deploy/firewall.sh                 SSH on port 22
#   sudo SSH_PORT=2222 sh deploy/firewall.sh   SSH on another port
#
# Run it again now and then: it replaces its earlier rules with Cloudflare's current ranges
# (https://www.cloudflare.com/ips/). Your VPS provider's own firewall, if it has one, works on top of this.
set -eu
command -v ufw >/dev/null || { echo "ufw is not installed: sudo apt install ufw" >&2; exit 1; }

v4=$(curl -fsS https://www.cloudflare.com/ips-v4)
v6=$(curl -fsS https://www.cloudflare.com/ips-v6)
case "$v4" in *.*/*) ;; *) echo "Could not fetch Cloudflare's IPv4 ranges; nothing changed." >&2; exit 1 ;; esac
case "$v6" in *:*/*) ;; *) echo "Could not fetch Cloudflare's IPv6 ranges; nothing changed." >&2; exit 1 ;; esac

# SSH first, so enabling the firewall cannot lock out this session. "limit" slows down password guessing.
ufw limit "${SSH_PORT:-22}/tcp" comment ssh
ufw default deny incoming
ufw default allow outgoing

# Remove the rules an earlier run added (highest number first, so the numbering holds), then add the current ones.
ufw status numbered | awk -F'[][]' '/# cloudflare/ { print $2 }' | sort -rn | while read -r n; do ufw --force delete "$n"; done
for range in $v4 $v6; do
  ufw allow proto tcp from "$range" to any port 443 comment cloudflare
done

ufw --force enable
ufw status verbose
