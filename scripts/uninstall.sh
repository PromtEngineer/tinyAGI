#!/usr/bin/env bash
# tinyAGI CLI Uninstallation Script

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}tinyAGI CLI Uninstaller${NC}"
echo "======================="
echo ""

FOUND=false

for INSTALL_DIR in "/usr/local/bin" "$HOME/.local/bin"; do
    for CMD in tinyagi tinyclaw; do
        if [ -L "$INSTALL_DIR/$CMD" ]; then
            FOUND=true
            TARGET="$(readlink "$INSTALL_DIR/$CMD")"

            echo -e "Found ${CMD} at: ${YELLOW}$INSTALL_DIR/$CMD${NC}"
            echo -e "Points to: ${YELLOW}$TARGET${NC}"
            echo ""

            read -p "Remove this symlink? (y/N) " -n 1 -r
            echo ""

            if [[ $REPLY =~ ^[Yy]$ ]]; then
                rm "$INSTALL_DIR/$CMD"
                echo -e "${GREEN}✓ Removed $INSTALL_DIR/$CMD${NC}"
            else
                echo "Skipped."
            fi
            echo ""
        fi
    done
done

if [ "$FOUND" = false ]; then
    echo -e "${YELLOW}No tinyAGI installation found${NC}"
    echo ""
    echo "Checked locations:"
    echo "  - /usr/local/bin/tinyagi"
    echo "  - /usr/local/bin/tinyclaw"
    echo "  - ~/.local/bin/tinyagi"
    echo "  - ~/.local/bin/tinyclaw"
fi

echo -e "${GREEN}Uninstallation complete${NC}"
echo ""
echo "Note: This only removes CLI symlinks."
echo "The project directory and ~/.tinyagi state are preserved."
echo ""
