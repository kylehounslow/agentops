FROM gcr.io/distroless/base-debian12
COPY otelcol-genai /otelcol-genai
EXPOSE 4317 4318
ENTRYPOINT ["/otelcol-genai"]
CMD ["--config", "/etc/otelcol/config.yaml"]
