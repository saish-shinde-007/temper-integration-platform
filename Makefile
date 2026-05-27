.PHONY: setup demo stop deploy test clean

setup:
	@echo "==> Installing dependencies..."
	pnpm install
	@echo "==> Building all packages..."
	pnpm -r build
	@echo "==> Pulling sandbox base image..."
	docker pull node:20-slim
	@echo "==> Building sandbox base image..."
	docker build -t temper-sandbox-base:latest packages/sandbox/docker
	@echo "==> Done. Copy .env.example to .env and set ANTHROPIC_API_KEY before running 'make demo'."

demo:
	@echo "==> Starting infrastructure (mocks + egress proxy)..."
	docker compose up -d mock-system-a mock-system-b mock-sftp egress-proxy
	@echo "==> Starting platform services (UI + API + runner + workflow worker)..."
	@echo "    Note: the API runs in StubTemporal mode by default — for real Temporal,"
	@echo "    install Temporal CLI and run 'temporal server start-dev' in another shell."
	TEMPER_USE_STUB_TEMPORAL=1 pnpm -r --parallel dev

stop:
	docker compose down
	pkill -f 'pnpm.*dev' || true
	pkill -f 'tsx watch' || true

deploy:
	bash scripts/deploy-gcp.sh

test:
	pnpm -r test

clean:
	rm -rf node_modules packages/*/node_modules packages/*/dist
	rm -rf data
	docker compose down -v
