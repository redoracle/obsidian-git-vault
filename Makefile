SHELL := /bin/sh

.DEFAULT_GOAL := help

PNPM ?= pnpm
NODE ?= node
ZIP ?= zip

PLUGIN_ID := $(shell $(NODE) -p "require('./manifest.json').id")
PLUGIN_VERSION := $(shell $(NODE) -p "require('./manifest.json').version")
ARTIFACTS_DIR := .artifacts
PACKAGE_DIR := $(ARTIFACTS_DIR)/$(PLUGIN_ID)
PACKAGE_ZIP := $(ARTIFACTS_DIR)/$(PLUGIN_ID)-$(PLUGIN_VERSION).zip
RELEASE_FILES := main.js manifest.json styles.css
PRETTIER_REPO_TARGETS := src docs README.md package.json manifest.json tsconfig.json esbuild.config.mjs eslint.config.mjs svelte-shims.d.ts .github .vscode

.PHONY: \
	help \
	doctor \
	install \
	install-frozen \
	dev \
	build \
	rebuild \
	tsc \
	svelte \
	lint \
	test \
	format-check \
	format-write \
	format-repo-check \
	format-repo-write \
	check \
	ci \
	release \
	package-dir \
	package \
	artifacts \
	print-plugin-id \
	print-version \
	clean \
	distclean \
	playwright \
	playwright-all \
	playwright-provider \
	playwright-line-author \
	playwright-plugin \
	playwright-screenshots

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*## "}; /^[a-zA-Z0-9_.-]+:.*## / {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

doctor: ## Print toolchain and plugin metadata
	@echo "Plugin ID: $(PLUGIN_ID)"
	@echo "Plugin version: $(PLUGIN_VERSION)"
	@echo "Node: $$($(NODE) --version)"
	@echo "pnpm: $$($(PNPM) --version)"
	@echo "TypeScript: $$($(NODE) -p "require('./node_modules/typescript/package.json').version")"
	@echo "Svelte: $$($(NODE) -p "require('./node_modules/svelte/package.json').version")"

install: ## Install dependencies
	$(PNPM) install

install-frozen: ## Install dependencies with the lockfile enforced
	$(PNPM) install --frozen-lockfile

dev: ## Run esbuild in watch mode
	$(PNPM) run dev

build: ## Build the Obsidian plugin bundle
	$(PNPM) run build

rebuild: clean build ## Clean generated files and rebuild

tsc: ## Run TypeScript type checking
	$(PNPM) run tsc

svelte: ## Run svelte-check
	$(PNPM) run svelte

lint: ## Run ESLint over src
	$(PNPM) run lint

test: ## Run the Vitest suite
	$(PNPM) run test

format-check: ## Run the repo's existing Prettier check over src
	$(PNPM) run format

format-write: ## Format src in place with Prettier
	$(PNPM) exec prettier --write src

format-repo-check: ## Run Prettier check across source, docs, and config files
	$(PNPM) exec prettier --check $(PRETTIER_REPO_TARGETS)

format-repo-write: ## Format source, docs, and config files in place
	$(PNPM) exec prettier --write $(PRETTIER_REPO_TARGETS)

check: ## Run the full local verification suite used by package.json
	$(PNPM) run tsc
	$(PNPM) run svelte
	$(MAKE) format-repo-check
	$(PNPM) run lint

ci: install-frozen check build ## Reproduce the local CI path: install, verify, build

release: ## Run standard-version to update changelog and create a release tag
	$(PNPM) run release

# Playwright test runner with category support
# Usage:
#   make playwright                # run all playwright tests (default)
#   make playwright CATEGORY=provider
#   make playwright CATEGORY=line-author
#   make playwright CATEGORY=plugin
#   make playwright CATEGORY=screenshots
# Extra Playwright CLI flags can be passed via PLAYWRIGHT_FLAGS.

PLAYWRIGHT_CMD ?= $(PNPM) exec playwright test

ifneq ($(CATEGORY),)
	ifeq ($(CATEGORY),all)
		PLAY_ARGS :=
	else ifeq ($(CATEGORY),provider)
		PLAY_ARGS := tests/e2e/provider-*.spec.ts tests/e2e/git-provider-settings.spec.ts
	else ifeq ($(CATEGORY),line-author)
		PLAY_ARGS := tests/e2e/line-author*.spec.ts
	else ifeq ($(CATEGORY),plugin)
		PLAY_ARGS := tests/e2e/plugin.test.ts
	else ifeq ($(CATEGORY),screenshots)
		PLAY_ARGS := tests/e2e/screenshots.test.ts
	else
		# Allow passing an arbitrary path or glob via CATEGORY
		PLAY_ARGS := $(CATEGORY)
	endif
endif

playwright: ## Run Playwright tests. Set CATEGORY to choose a subset (see Makefile comments).
	@echo "Running Playwright tests (CATEGORY='$(CATEGORY)')"
	$(PLAYWRIGHT_CMD) $(PLAY_ARGS) $(PLAYWRIGHT_FLAGS)

playwright-all: ## Convenience: run all Playwright tests
	$(MAKE) playwright CATEGORY=all

playwright-provider: ## Convenience: run provider-related Playwright tests
	$(MAKE) playwright CATEGORY=provider

playwright-line-author: ## Convenience: run line-author Playwright tests
	$(MAKE) playwright CATEGORY=line-author

playwright-plugin: ## Convenience: run plugin Playwright tests
	$(MAKE) playwright CATEGORY=plugin

playwright-screenshots: ## Convenience: run screenshot Playwright tests
	$(MAKE) playwright CATEGORY=screenshots

package-dir: build ## Stage release files under .artifacts/<plugin-id>/
	rm -rf $(PACKAGE_DIR)
	mkdir -p $(PACKAGE_DIR)
	cp $(RELEASE_FILES) $(PACKAGE_DIR)/

package: package-dir ## Build and create a versioned release zip
	rm -f $(PACKAGE_ZIP)
	cd $(ARTIFACTS_DIR) && $(ZIP) -rq "$(notdir $(PACKAGE_ZIP))" "$(PLUGIN_ID)"

artifacts: package ## Alias for package

print-plugin-id: ## Print the manifest plugin id
	@echo $(PLUGIN_ID)

print-version: ## Print the manifest version
	@echo $(PLUGIN_VERSION)

clean: ## Remove generated build outputs and local caches
	rm -f main.js main.js.map
	rm -f .eslintcache
	rm -f *.tsbuildinfo
	rm -rf .sass-cache
	rm -rf $(ARTIFACTS_DIR)

distclean: clean ## Remove generated files plus installed dependencies
	rm -rf node_modules
