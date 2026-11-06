# Reproducible setup and verification. Everything runs in project-labelled containers; the host
# needs only Docker and git. Cleanup targets touch only this project's labelled containers.
SHELL := /bin/bash
PROJECT := fruit-ninja-self-mcp
TAG ?= $(shell git rev-parse --short=12 HEAD 2>/dev/null || echo dev)
NODE_IMAGE ?= node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
DOCKER_CLI_IMAGE ?= docker:29.1.3-cli@sha256:4fa0ee1f3a7e4354c4ea34558b6d4ee32859baf4973d4c8ccc8e7fe3dd730c04
EVALUATOR := $(PROJECT)/evaluator:$(TAG)
DOCKER_GID := $(shell stat -c %g /var/run/docker.sock 2>/dev/null || echo 0)
RUN := docker run --rm --user $(shell id -u):$(shell id -g) --group-add $(DOCKER_GID) \
	--label fnsm.project=$(PROJECT) --label fnsm.role=evaluator --shm-size 1g --cpus 4 --memory 8g \
	-e HOME=/tmp -e FNSM_IMAGE_TAG=$(TAG) -e FNSM_DOCKER=1 -e npm_config_cache=$(CURDIR)/.local/npm-cache -e npm_config_update_notifier=false \
	-v /var/run/docker.sock:/var/run/docker.sock -v $(CURDIR):$(CURDIR) -w $(CURDIR) $(EVALUATOR)

.PHONY: all evaluator setup images test check preview shell clean-containers
all: setup images check test preview

evaluator:
	docker build --build-arg NODE_IMAGE=$(NODE_IMAGE) --build-arg DOCKER_CLI_IMAGE=$(DOCKER_CLI_IMAGE) \
		--label fnsm.project=$(PROJECT) -t $(EVALUATOR) -f sandbox/Dockerfile.evaluator sandbox

setup: evaluator
	$(RUN) sh -c 'npm ci --no-audit --no-fund && npm run setup && npm run build && npm run package'

images:
	$(RUN) sh -c 'npm run build && npm run package'
	docker build --build-arg NODE_IMAGE=$(NODE_IMAGE) --label fnsm.project=$(PROJECT) \
		-t $(PROJECT)/builder:$(TAG) -f sandbox/Dockerfile.builder .local/context/builder
	docker build --build-arg NODE_IMAGE=$(NODE_IMAGE) --label fnsm.project=$(PROJECT) \
		-t $(PROJECT)/play:$(TAG) -f sandbox/Dockerfile.play .local/context/play

check:
	$(RUN) sh -c 'npm run typecheck && npm run format:check'

test:
	$(RUN) $(if $(FILES),node --import tsx --test --test-concurrency=1 $(FILES),npm test)

preview:
	$(RUN) npm run preview -- $(ARGS)

shell:
	docker run --rm -it --user $(shell id -u):$(shell id -g) --group-add $(DOCKER_GID) \
		-e HOME=/tmp -e FNSM_IMAGE_TAG=$(TAG) -e FNSM_DOCKER=1 \
		-v /var/run/docker.sock:/var/run/docker.sock -v $(CURDIR):$(CURDIR) -w $(CURDIR) $(EVALUATOR) bash

clean-containers:
	docker ps -aq --filter label=fnsm.project=$(PROJECT) | xargs -r docker rm -f
