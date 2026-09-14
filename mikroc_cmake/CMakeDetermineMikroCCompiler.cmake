set(CMAKE_MikroC_COMPILER_ENV_VAR "MikroC")
get_filename_component(CURRENT_DIR ${CMAKE_CURRENT_LIST_FILE} DIRECTORY)
configure_file("${CURRENT_DIR}/CMakeMikroCCompiler.cmake.in"
    "${CMAKE_BINARY_DIR}/${CMAKE_FILES_DIRECTORY}/${CMAKE_VERSION}/CMakeMikroCCompiler.cmake"
    IMMEDIATE )