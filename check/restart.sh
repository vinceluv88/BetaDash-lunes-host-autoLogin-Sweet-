#!/bin/sh
nohup /home/container/agsb/xray run -c /home/container/agsb/xr.json > /dev/null 2>&1 &
sleep3
nohup /home/container/agsb/cloudflared tunnel --no-autoupdate --edge-ip-version auto --protocol http2 run --token eyJhIjoiZTZhZTliNTBjZDNkZjJkZGEyY2FhZjg2N2FlMWQ1ZWYiLCJ0IjoiMGM0MjliODMtNTg2ZS00ZmQ3LTk3NzEtZmIyZTI3ZmY5YjdhIiwicyI6Ik56UXdOVEl4T1dVdFpHSXdZUzAwTjJJNExUZzJNVEl0WXpSaFpURTNPVGN3TnpFNCJ9 > /dev/null 2>&1 &
sleep 3
nohup /home/container/cf-vps-monitor.sh -i -k 27e2628a670e6aa35bd71bd54c3b6c5b0e65cda98e918dba4058d4b07e91f457 -s o3sfp5 -u https://monitor.yahaibiotech.dpdns.org > /dev/null 2>&1 &
