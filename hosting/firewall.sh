#!/bin/sh
# Lets HTTPS (443) in only from Cloudflare, keeps SSH open, and closes every other incoming port. Uses ufw.
#
#   sudo sh hosting/firewall.sh                 SSH on port 22
#   sudo SSH_PORT=2222 sh hosting/firewall.sh   SSH on another port
#
# Run it again now and then: it replaces its earlier rules with Cloudflare's current ranges
# (https://www.cloudflare.com/ips/). Your VPS provider's own firewall, if it has one, works on top of this.
set -eu
command -v ufw >/dev/null || { echo "ufw is not installed: sudo apt install ufw" >&2; exit 1; }

v4=$(curl -fsS --proto =https --tlsv1.2 --max-time 30 https://www.cloudflare.com/ips-v4)
v6=$(curl -fsS --proto =https --tlsv1.2 --max-time 30 https://www.cloudflare.com/ips-v6)
case "$v4" in *.*/*) ;; *) echo "Could not fetch Cloudflare's IPv4 ranges; nothing changed." >&2; exit 1 ;; esac
case "$v6" in *:*/*) ;; *) echo "Could not fetch Cloudflare's IPv6 ranges; nothing changed." >&2; exit 1 ;; esac
# Every line must be a plain range, such as 173.245.48.0/20 or 2400:cb00::/32, and none may open the whole internet
# (a /0, or anything wider than /8 or /16): otherwise nothing is changed.
for range in $v4; do
  printf '%s\n' "$range" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}/([89]|[12][0-9]|3[0-2])$' \
    || { echo "Unexpected IPv4 range from Cloudflare: $range; nothing changed." >&2; exit 1; }
done
for range in $v6; do
  printf '%s\n' "$range" | grep -Eiq '^[0-9a-f:]{2,39}/(1[6-9]|[2-9][0-9]|1[01][0-9]|12[0-8])$' \
    || { echo "Unexpected IPv6 range from Cloudflare: $range; nothing changed." >&2; exit 1; }
done

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
