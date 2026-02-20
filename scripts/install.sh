#!/usr/bin/env bash
# tinyAGI CLI Installation Script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WRAPPER_TINYAGI="$PROJECT_ROOT/bin/tinyagi"
WRAPPER_TINYCLAW="$PROJECT_ROOT/bin/tinyclaw"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}tinyAGI CLI Installer${NC}"
echo "===================="
echo ""

if [ ! -f "$WRAPPER_TINYAGI" ]; then
    echo -e "${RED}Error: tinyagi wrapper not found at $WRAPPER_TINYAGI${NC}"
    exit 1
fi

INSTALL_DIR=""
if [ -w "/usr/local/bin" ]; then
    INSTALL_DIR="/usr/local/bin"
    echo -e "Installing to: ${GREEN}/usr/local/bin${NC} (system-wide)"
elif [ -d "$HOME/.local/bin" ]; then
    INSTALL_DIR="$HOME/.local/bin"
    echo -e "Installing to: ${GREEN}~/.local/bin${NC} (user)"
else
    mkdir -p "$HOME/.local/bin"
    INSTALL_DIR="$HOME/.local/bin"
    echo -e "Installing to: ${GREEN}~/.local/bin${NC} (user, created)"
fi

link_cmd() {
    local link_name="$1"
    local target="$2"
    local full_link="$INSTALL_DIR/$link_name"

    if [ -L "$full_link" ]; then
        rm "$full_link"
    elif [ -e "$full_link" ]; then
        echo -e "${RED}Error: $full_link exists and is not a symlink${NC}"
        echo "Please remove it manually and re-run install."
        exit 1
    fi

    ln -s "$target" "$full_link"
}

echo ""
echo "Creating symlinks..."
link_cmd "tinyagi" "$WRAPPER_TINYAGI"
if [ -f "$WRAPPER_TINYCLAW" ]; then
    link_cmd "tinyclaw" "$WRAPPER_TINYCLAW"
fi

echo -e "${GREEN}✓ tinyAGI CLI installed successfully!${NC}"
echo ""
echo "You can now run:"
echo -e "  ${GREEN}tinyagi start${NC}      - Start tinyAGI"
echo -e "  ${GREEN}tinyagi status${NC}     - Check status"
echo -e "  ${GREEN}tinyclaw status${NC}    - Legacy alias"
echo ""

if command -v tinyagi &> /dev/null; then
    echo -e "${GREEN}✓ 'tinyagi' command is available${NC}"
elif [ "$INSTALL_DIR" = "$HOME/.local/bin" ]; then
    SHELL_NAME="$(basename "$SHELL")"
    SHELL_PROFILE=""
    case "$SHELL_NAME" in
        zsh)  SHELL_PROFILE="$HOME/.zshrc" ;;
        bash)
            if [ -f "$HOME/.bash_profile" ]; then
                SHELL_PROFILE="$HOME/.bash_profile"
            else
                SHELL_PROFILE="$HOME/.bashrc"
            fi
            ;;
        *)    SHELL_PROFILE="$HOME/.profile" ;;
    esac

    PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

    if [ -n "$SHELL_PROFILE" ] && ! grep -qF '.local/bin' "$SHELL_PROFILE" 2>/dev/null; then
        echo "" >> "$SHELL_PROFILE"
        echo "# Added by tinyAGI installer" >> "$SHELL_PROFILE"
        echo "$PATH_LINE" >> "$SHELL_PROFILE"
        echo -e "${GREEN}✓ Added ~/.local/bin to PATH in ${SHELL_PROFILE/#$HOME/\~}${NC}"
    fi

    export PATH="$HOME/.local/bin:$PATH"
    echo -e "${YELLOW}⚠ Restart your terminal or run: source ${SHELL_PROFILE/#$HOME/\~}${NC}"
else
    echo -e "${YELLOW}⚠ 'tinyagi' command not found in PATH${NC}"
    echo "  Add $INSTALL_DIR to your PATH."
fi

echo ""
echo "To uninstall, run:"
echo -e "  ${GREEN}./uninstall.sh${NC}"
echo ""
