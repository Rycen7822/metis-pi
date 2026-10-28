cmake_minimum_required(VERSION 3.28)
project(sgrep_cpu LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(ORT_SOURCE "" CACHE PATH "Pinned, patched ORT checkout")
set(ORT_BUILD "" CACHE PATH "ORT configuration build directory (ends in Release)")
if(NOT EXISTS "${ORT_SOURCE}/include/onnxruntime/core/session/onnxruntime_cxx_api.h")
  message(FATAL_ERROR "ORT_SOURCE must point to the pinned ORT source")
endif()
find_path(SGREP_JSON_INCLUDE nlohmann/json.hpp
  PATHS "${ORT_BUILD}/_deps/nlohmann_json-src/single_include"
        "${ORT_BUILD}/_deps/nlohmann_json-src/include" NO_DEFAULT_PATH REQUIRED)
add_library(sgrep_cpu SHARED runtime.cc custom_ops.cc score.cc)
target_compile_definitions(sgrep_cpu PRIVATE ORT_API_MANUAL_INIT)
target_compile_options(sgrep_cpu PRIVATE -Wall -Wextra -Wpedantic -fno-fast-math -ffp-contract=off)
target_include_directories(sgrep_cpu PRIVATE "${ORT_SOURCE}/include/onnxruntime/core/session"
  "${SGREP_JSON_INCLUDE}" PUBLIC include)
target_link_libraries(sgrep_cpu PRIVATE "${ORT_BUILD}/libonnxruntime.so")
target_link_options(sgrep_cpu PRIVATE -Wl,--no-undefined)
set_target_properties(sgrep_cpu PROPERTIES BUILD_RPATH "$ORIGIN;${ORT_BUILD}" INSTALL_RPATH "$ORIGIN")
# Stage through CMake so installed libraries cannot fall back to the build tree.
install(TARGETS sgrep_cpu LIBRARY DESTINATION lib)
