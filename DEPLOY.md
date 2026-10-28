# Deploy checklist (PowerShell, project folder)

    npm.cmd install
    npm.cmd test                      # expect 25 passing
    git status                        # index.backup.js must NOT be listed (it is now git-ignored)
    git add -A
    git commit -m "Production Redis API, helper and docs"
    git push origin main              # Vercel deploys automatically

When the Vercel deployment is "Ready":

    node scripts/smoke.mjs https://slidelink-gamma.vercel.app     # expect: 17 passed, 0 failed

Then:

    $env:SLIDELINK_SERVER = "https://slidelink-gamma.vercel.app"
    python .\helper\slidelink_helper.py

Phone: https://slidelink-gamma.vercel.app/remote.html

If the live smoke test fails: Vercel dashboard > Deployments > previous deployment > Promote to Production (instant rollback), and send me the smoke output.
