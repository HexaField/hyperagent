PYTHON ?= python3
PIP ?= $(PYTHON) -m pip
NPM ?= npm
NPM_RUN ?= $(NPM) run
MODEL ?= llama3.2:latest
BACKEND_PORT ?= 8000
WEBAPP_PORT ?= 5173
BACKEND_DIR := backend
TS_CLIENT_DIR := ts-client
WEBAPP_DIR := webapp

.PHONY: help install-backend install-ts-client install-webapp build-ts-client run-backend run-webapp test-e2e dev run

help:
	@echo "Targets:"
	@echo "  make install-backend     # pip install backend requirements"
	@echo "  make install-ts-client   # npm install in ts-client"
	@echo "  make install-webapp      # npm install in webapp"
	@echo "  make build-ts-client     # build TypeScript client"
	@echo "  make run-backend         # start FastAPI backend"
	@echo "  make run-webapp          # start SolidJS dev server"
	@echo "  make run                 # run backend and webapp concurrently"
	@echo "  make test-e2e            # run Playwright UI test (starts backend + webapp)"

install-backend:
	$(PIP) install -r $(BACKEND_DIR)/requirements.txt

install-ts-client:
	cd $(TS_CLIENT_DIR) && $(NPM) install

build-ts-client: install-ts-client
	cd $(TS_CLIENT_DIR) && $(NPM_RUN) build

install-webapp:
	cd $(WEBAPP_DIR) && $(NPM) install

run-backend:
	STREAMING_LLM_MODEL=$(MODEL) \
	STREAMING_LLM_ENABLE=1 \
	STREAMING_LLM_START_SIZE=4 \
	STREAMING_LLM_RECENT_SIZE=2048 \
	$(PYTHON) -m $(BACKEND_DIR).server

run-webapp:
	cd $(WEBAPP_DIR) && VITE_BACKEND_HTTP=http://localhost:$(BACKEND_PORT) \
	VITE_BACKEND_WS=ws://localhost:$(BACKEND_PORT)/ws/chat \
	$(NPM_RUN) dev -- --host 0.0.0.0 --port $(WEBAPP_PORT)

test-e2e: install-backend install-webapp build-ts-client
	cd $(WEBAPP_DIR) && npx playwright test

run:
	$(MAKE) -j2 run-backend run-webapp

dev:
	@echo "Run backend and webapp in two shells:"
	@echo "  make run-backend"
	@echo "  make run-webapp"
