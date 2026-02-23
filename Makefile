# OCR Platform - Makefile
# Chạy từ thư mục gốc repo: make <target>
# Cần: Docker, docker compose

COMPOSE_FILE = infra/docker-compose.yml
COMPOSE = docker compose -f $(COMPOSE_FILE)

.PHONY: help up down build logs ps

help:
	@echo "OCR Platform - Lệnh make"
	@echo ""
	@echo "  make up          Chạy toàn bộ stack (redis, postgres, api, worker)"
	@echo "  make down        Dừng và xóa containers"
	@echo "  make build       Build lại image api + worker"
	@echo "  make logs        Xem logs tất cả services"
	@echo "  make ps          Liệt kê containers"
	@echo ""
	@echo "Chạy từng service:"
	@echo "  make redis       Chạy Redis"
	@echo "  make postgres    Chạy Postgres"
	@echo "  make api         Chạy API (phụ thuộc redis, postgres)"
	@echo "  make worker      Chạy Worker (phụ thuộc redis, postgres)"
	@echo ""
	@echo "Dừng từng service:"
	@echo "  make stop-api    Dừng API"
	@echo "  make stop-worker Dừng Worker"
	@echo "  make stop-redis  Dừng Redis"
	@echo "  make stop-postgres Dừng Postgres"
	@echo ""

# --- Chạy toàn bộ ---
up:
	$(COMPOSE) up -d

up-build:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

build:
	$(COMPOSE) build

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps

# --- Từng service (up -d <service>) ---
redis:
	$(COMPOSE) up -d redis

postgres:
	$(COMPOSE) up -d postgres

api: postgres redis
	$(COMPOSE) up -d api

worker: postgres redis
	$(COMPOSE) up -d worker

# --- Dừng từng service ---
stop-api:
	$(COMPOSE) stop api

stop-worker:
	$(COMPOSE) stop worker

stop-redis:
	$(COMPOSE) stop redis

stop-postgres:
	$(COMPOSE) stop postgres

# --- Tiện ích ---
clean:
	$(COMPOSE) down -v
	@echo "Đã xóa containers và volumes."

shell-api:
	$(COMPOSE) exec api sh

shell-worker:
	$(COMPOSE) exec worker sh
