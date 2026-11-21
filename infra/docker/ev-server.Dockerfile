FROM golang:1.23-alpine AS build
WORKDIR /src
COPY services/ev-server/go.mod ./
COPY services/ev-server ./
RUN go build -o /out/ev-server ./cmd/ev-server

FROM alpine:3.21
WORKDIR /app
COPY --from=build /out/ev-server /usr/local/bin/ev-server
EXPOSE 17878
CMD ["ev-server"]
