# syntax=docker/dockerfile:1
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
# GO_TAGS=testhooks only for the CI stack (adjustable clock and admin hooks; docs/TESTING_AND_CI.md §3).
ARG GO_TAGS=
RUN CGO_ENABLED=0 go build -trimpath -tags "${GO_TAGS}" -ldflags "-s -w -X main.version=${VERSION}" -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/server"]
