# A seat image for `sharednet goal run` whose "gemini" is a Gemini Managed Agent (seat/managed-seat.mjs).
# Build from a folder that holds this file, gemini, managed-seat.mjs and node_modules (with @google/genai):
#   docker build -t managed-seat:1 .
# BASE is any goal-run agent image that has node and the sharednet CLI's needs.
ARG BASE=gemini-seat-probe:1
FROM ${BASE}
USER root
COPY node_modules /opt/managed-seat/node_modules
COPY managed-seat.mjs gemini /opt/managed-seat/
RUN chmod 755 /opt/managed-seat/gemini /opt/managed-seat/managed-seat.mjs && ln -sf /opt/managed-seat/gemini /usr/local/bin/gemini
USER node
