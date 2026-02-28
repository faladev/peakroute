#!/bin/bash
set -e

# Script para criar um novo release do peakroute
# Uso: ./scripts/release.sh [patch|minor|major]
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

VERSION_TYPE=${1:-patch}

if [[ ! "$VERSION_TYPE" =~ ^(patch|minor|major)$ ]]; then
    echo "Erro: Tipo de versão deve ser patch, minor ou major"
    echo "Uso: ./scripts/release.sh [patch|minor|major]"
    exit 1
fi

# Verificar se está na branch main
current_branch=$(git branch --show-current)
if [ "$current_branch" != "main" ]; then
    echo "Erro: Você deve estar na branch main para criar um release"
    exit 1
fi

# Verificar se há alterações não commitadas
if [ -n "$(git status --porcelain)" ]; then
    echo "Erro: Há alterações não commitadas. Faça commit ou stash antes de continuar."
    git status
    exit 1
fi

# Ir para o diretório do pacote
cd packages/peakroute

# Obter versão atual
current_version=$(cat package.json | grep -o '"version": "[^"]*"' | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
echo "Versão atual: $current_version"

# Calcular nova versão
IFS='.' read -r major minor patch <<< "$current_version"

case $VERSION_TYPE in
    major)
        new_version=$((major + 1)).0.0
        ;;
    minor)
        new_version=$major.$((minor + 1)).0
        ;;
    patch)
        new_version=$major.$minor.$((patch + 1))
        ;;
esac

echo "Nova versão: $new_version"

# Atualizar package.json
sed -i "s/\"version\": \"$current_version\"/\"version\": \"$new_version\"/" package.json

# Voltar para a raiz do repo
cd ../..

# Commit da alteração de versão
git add packages/peakroute/package.json
git commit -m "chore: bump version to $new_version"

# Push para o GitHub (dispara o workflow de release)
echo "Enviando para o GitHub..."
git push origin main

echo ""
echo "✅ Versão $new_version commitada e enviada!"
echo ""
echo "O workflow de CI/CD vai:"
echo "  1. Detectar a mudança de versão"
echo "  2. Publicar no npm"
echo "  3. Criar uma release no GitHub com o artefato"
echo "  4. Criar a tag git automaticamente"
echo ""
echo "Acompanhe o progresso em: https://github.com/faladev/peakroute/actions"
echo ""
echo "📝 Nota: Após o primeiro release, adicione a org @faladev como owner:"
echo "   npm access grant read-write faladev:developers peakroute"
