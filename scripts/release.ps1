# Script para criar um novo release do peakroute (Windows)
# Uso: .\scripts\release.ps1 [patch|minor|major]
#
# Este script:
# 1. Atualiza a versão no package.json
# 2. Commita a mudança
# 3. Faz push para a main (dispara o workflow de release)
#
# O workflow de CI/CD vai:
# - Detectar a mudança de versão
# - Publicar no npm
# - Criar a release no GitHub com o artefato
# - Criar a tag git

param(
    [Parameter()]
    [ValidateSet("patch", "minor", "major")]
    [string]$VersionType = "patch"
)

# Verificar se está na branch main
$currentBranch = git branch --show-current
if ($currentBranch -ne "main") {
    Write-Error "Erro: Você deve estar na branch main para criar um release"
    exit 1
}

# Verificar se há alterações não commitadas
$status = git status --porcelain
if ($status) {
    Write-Error "Erro: Há alterações não commitadas. Faça commit ou stash antes de continuar."
    git status
    exit 1
}

# Ir para o diretório do pacote
Set-Location packages/peakroute

# Obter versão atual
$packageJson = Get-Content package.json -Raw | ConvertFrom-Json
$currentVersion = $packageJson.version
Write-Host "Versão atual: $currentVersion"

# Calcular nova versão
$versionParts = $currentVersion -split '\.'
$major = [int]$versionParts[0]
$minor = [int]$versionParts[1]
$patch = [int]$versionParts[2]

switch ($VersionType) {
    "major" { $newVersion = "$(($major + 1)).0.0" }
    "minor" { $newVersion = "$major.$(($minor + 1)).0" }
    "patch" { $newVersion = "$major.$minor.$(($patch + 1))" }
}

Write-Host "Nova versão: $newVersion"

# Atualizar package.json
$packageJson.version = $newVersion
$packageJson | ConvertTo-Json -Depth 10 | Set-Content package.json

# Voltar para a raiz do repo
Set-Location ../..

# Commit da alteração de versão
git add packages/peakroute/package.json
git commit -m "chore: bump version to $newVersion"

# Push para o GitHub (dispara o workflow de release)
Write-Host "Enviando para o GitHub..."
git push origin main

Write-Host ""
Write-Host "✅ Versão $newVersion commitada e enviada!" -ForegroundColor Green
Write-Host ""
Write-Host "O workflow de CI/CD vai:"
Write-Host "  1. Detectar a mudança de versão"
Write-Host "  2. Publicar no npm"
Write-Host "  3. Criar uma release no GitHub com o artefato"
Write-Host "  4. Criar a tag git automaticamente"
Write-Host ""
Write-Host "Acompanhe o progresso em: https://github.com/faladev/peakroute/actions"
Write-Host ""
Write-Host "📝 Nota: Após o primeiro release, adicione a org @faladev como owner:"
Write-Host "   npm access grant read-write faladev:developers peakroute"
