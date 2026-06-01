UUID = claude-screen@pippsza
EXTDIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: install uninstall enable pack

install:
	mkdir -p "$(EXTDIR)"
	cp -f metadata.json extension.js "$(EXTDIR)/"
	@echo "Installed to $(EXTDIR)"
	@echo "Now log out / back in (Wayland), then: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf "$(EXTDIR)"

enable:
	gnome-extensions enable $(UUID)

pack:
	gnome-extensions pack --force \
	  --extra-source=metadata.json \
	  .
