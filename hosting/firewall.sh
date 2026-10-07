#!/bin/sh
# The machine's firewall, with ufw: SSH stays open (rate-limited), and every other incoming port is closed, except
#
#   sudo sh hosting/firewall.sh              HTTPS (443) only from Cloudflare: for when every site goes through Cloudflare
#   sudo sh hosting/firewall.sh open         HTTP and HTTPS (80 and 443, with HTTP/3 on 443/udp) from everyone: for
#                                            sites reached directly (Let's Encrypt, or a certificate of your own).
#                                            A site through Cloudflare still lets in only Cloudflare, by its client
#                                            certificate (Authenticated Origin Pulls).
#   SSH_PORT=2222 sh hosting/firewall.sh …   SSH on another port than 22
#
# Run it again now and then (Cloudflare's ranges change), and to switch between the two: it replaces the rules an
# earlier run added. Your VPS provider's own firewall, if it has one, works on top of this.
set -eu
mode=${1:-cloudflare}
case "$mode" in
  cloudflare|open) ;;
  *) echo "Usage: sudo sh firewall.sh [open]" >&2; exit 2 ;;
esac
command -v ufw >/dev/null || { echo "ufw is not installed: sudo apt install ufw" >&2; exit 1; }

if [ "$mode" = cloudflare ]; then
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
fi

# SSH first, so enabling the firewall cannot lock out this session. "limit" slows down password guessing.
ufw limit "${SSH_PORT:-22}/tcp" comment ssh
ufw default deny incoming
ufw default allow outgoing

# Remove the rules an earlier run added, in either mode (highest number first, so the numbering holds), then add this
# mode's.
ufw status numbered | awk -F'[][]' '/# (cloudflare|web)[[:space:]]*$/ { print $2 }' | sort -rn | while read -r n; do ufw --force delete "$n"; done
if [ "$mode" = open ]; then
  ufw allow 80/tcp comment web
  ufw allow 443/tcp comment web
  ufw allow 443/udp comment web
else
  for range in $v4 $v6; do
    ufw allow proto tcp from "$range" to any port 443 comment cloudflare
  done
fi

ufw --force enable
ufw status verbose
