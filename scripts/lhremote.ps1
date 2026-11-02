$entrypoint = Join-Path $PSScriptRoot 'lhremote\dist\cli.js'
if ($MyInvocation.ExpectingInput) { $input | & node.exe $entrypoint @args }
else { & node.exe $entrypoint @args }
exit $LASTEXITCODE
