# -------- Build stage --------
FROM eclipse-temurin:21-jdk AS build
WORKDIR /app

# Copy gradle wrapper + build files first for better caching
COPY gradlew gradlew
COPY gradle gradle
COPY build.gradle* settings.gradle* gradle.properties* ./

# Copy source
COPY src src

# Build fat jar
RUN chmod +x gradlew && ./gradlew clean bootJar -x test

# -------- Run stage --------
FROM eclipse-temurin:21-jre
WORKDIR /app

# Copy jar from build stage
COPY --from=build /app/build/libs/*.jar app.jar

# Spring Boot default
EXPOSE 8080

# IMPORTANT: OPENAI_API_KEY comes from docker-compose env
ENV JAVA_OPTS=""

ENTRYPOINT ["sh","-c","java $JAVA_OPTS -jar /app/app.jar"]