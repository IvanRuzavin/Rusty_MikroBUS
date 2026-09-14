function (designer_generator _targetName)
    # set path to meresgen
    cmake_path(GET NECTO_DESIGNER_GENERATOR_PATH PARENT_PATH generator_path)
    set(ME_RESGEN_PATH "${generator_path}/meresgen")
    set(SCREENGEN_PATH "${NECTO_APPLICATION_DIR}/screen_generator")


    list(APPEND input_files "${ARGN}")
    foreach(file IN LISTS input_files)
        cmake_path(GET file EXTENSION LAST_ONLY mres_ext)
        string(REGEX MATCH "\.mres$" mres_result ${mres_ext})

        if(NOT EXISTS ${CMAKE_CURRENT_BINARY_DIR}/generated)
            make_directory(${CMAKE_CURRENT_BINARY_DIR}/generated)
        endif()

        # if it's resource file
        if(mres_result)
            get_filename_component(resrc_name_no_ext ${file} NAME_WE)
            get_filename_component(resrc_relative_dir ${file} DIRECTORY)
            add_custom_command(OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/generated/${resrc_relative_dir}/${resrc_name_no_ext}.c ${CMAKE_CURRENT_BINARY_DIR}/generated/${resrc_relative_dir}/${resrc_name_no_ext}.h
                COMMAND ${ME_RESGEN_PATH} --res ${CMAKE_CURRENT_SOURCE_DIR}/${file} --out ${CMAKE_CURRENT_BINARY_DIR}/generated/${resrc_relative_dir}/${resrc_name_no_ext}.c --hout ${CMAKE_CURRENT_BINARY_DIR}/generated/${resrc_relative_dir}/${resrc_name_no_ext}.h
                WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/
                DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/${file}
                COMMENT "Generating resources from ${CMAKE_CURRENT_SOURCE_DIR}/${file}."
                VERBATIM
            )
            execute_process(COMMAND ${ME_RESGEN_PATH} --res ${CMAKE_CURRENT_SOURCE_DIR}/${file} --out ${CMAKE_CURRENT_BINARY_DIR}/generated/${resrc_relative_dir}/${resrc_name_no_ext}.c --hout ${CMAKE_CURRENT_BINARY_DIR}/generated/${resrc_relative_dir}/${resrc_name_no_ext}.h
                            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/)
            list(APPEND designer_generated_sources
                ${CMAKE_CURRENT_BINARY_DIR}/generated/${resrc_relative_dir}/${resrc_name_no_ext}.c
                ${CMAKE_CURRENT_BINARY_DIR}/generated/${resrc_relative_dir}/${resrc_name_no_ext}.h
            )
        else()
        # if it's designer file

            get_filename_component(screen_no_ext ${file} NAME_WE)
            get_filename_component(screen_relative_dir ${file} DIRECTORY)
            list(APPEND designer_generated_sources
                ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.c
                ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.h
                        )

            # add_custom_command(OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.c ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.h
            # COMMAND ${CMAKE_COMMAND} -E echo "Generating source files for ${file}"
            # WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/
            # DEPENDS ${file}
            # COMMENT "Generating source files for ${file}."
            # VERBATIM
            # )

            add_custom_command(
                OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.c ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.h
                COMMAND ${SCREENGEN_PATH} screen
                    --input   ${CMAKE_CURRENT_SOURCE_DIR}/${file}
                    --header   ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.h
                    --source   ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.c
                    --generator "xx"
                DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/${file}
                WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/
                COMMENT "Generating screen from ${CMAKE_CURRENT_SOURCE_DIR}/${file}."
                VERBATIM
            )

        endif()
    endforeach()
    target_include_directories(${_targetName} PUBLIC ${CMAKE_CURRENT_BINARY_DIR}/generated/${resrc_relative_dir})
    target_include_directories(${_targetName} PUBLIC ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir})
    target_sources(${_targetName} PUBLIC ${designer_generated_sources})
endfunction()

function (lvgl_designer_generator _targetName)
    set(LVGL_RESGEN_PATH "${NECTO_APPLICATION_DIR}/lvglresgen")
    set(SCREENGEN_PATH "${NECTO_APPLICATION_DIR}/screen_generator")

    list(APPEND input_files "${ARGN}")
    foreach(file IN LISTS input_files)
        cmake_path(GET file EXTENSION LAST_ONLY mres_ext)
        string(REGEX MATCH "\.mres$" mres_result ${mres_ext})

        if(NOT EXISTS ${CMAKE_CURRENT_BINARY_DIR}/generated)
            make_directory(${CMAKE_CURRENT_BINARY_DIR}/generated)
        endif()
        if(NOT EXISTS ${CMAKE_CURRENT_BINARY_DIR}/generated/images)
            make_directory(${CMAKE_CURRENT_BINARY_DIR}/generated/images)
        endif()
        if(NOT EXISTS ${CMAKE_CURRENT_BINARY_DIR}/generated/fonts)
            make_directory(${CMAKE_CURRENT_BINARY_DIR}/generated/fonts)
        endif()

        # if it's resource file
        if(mres_result)

            execute_process(
                COMMAND ${LVGL_RESGEN_PATH}
                    --res ${CMAKE_CURRENT_SOURCE_DIR}/${file}
                    --out ${CMAKE_CURRENT_BINARY_DIR}/generated
                OUTPUT_VARIABLE resource_files
                WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/
                RESULT_VARIABLE exec_result_variable
                ERROR_VARIABLE proc_error
            )
            if (proc_error)
                message(STATUS "LVGLRESGEN PROCESS ERROR: ${proc_error}")
            endif()

            if (resource_files)
                string(REPLACE "\n" ";" designer_generated_sources ${resource_files})
                add_custom_command(
                    OUTPUT ${resource_files}
                    COMMAND ${LVGL_RESGEN_PATH}
                        --res   ${CMAKE_CURRENT_SOURCE_DIR}/${file}
                        --out   ${CMAKE_CURRENT_BINARY_DIR}/generated
                    DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/${file}
                    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/
                    COMMENT "Generating resources from ${CMAKE_CURRENT_SOURCE_DIR}/${file}."
                    VERBATIM
                )
            endif()

        else()
        # if it's designer file

            get_filename_component(screen_no_ext ${file} NAME_WE)
            get_filename_component(screen_relative_dir ${file} DIRECTORY)

            # Read the .mscr JSON and extract lvgl_version
            set(LVGL_VERSION "")
            file(READ "${CMAKE_CURRENT_SOURCE_DIR}/${file}" _mscr_json)

            # Match: "lvgl_version": "9.4.0"
            string(REGEX MATCH "\"lvgl_version\"[ \t\r\n]*:[ \t\r\n]*\"([^\"]+)\"" _m "${_mscr_json}")

            if(CMAKE_MATCH_1)
            set(LVGL_VERSION "${CMAKE_MATCH_1}")
            endif()


            list(APPEND screens_list ${screen_no_ext})
            list(APPEND designer_generated_sources
                ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.c
                ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.h
                        )
            set(resource_path ${CMAKE_CURRENT_SOURCE_DIR}/resource.mres)
            add_custom_command(
                    OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.c ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.h
                    COMMAND ${SCREENGEN_PATH} screen
                        --input   ${CMAKE_CURRENT_SOURCE_DIR}/${file}
                        --header   ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.h
                        --source   ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.c
                        --resource ${resource_path}
                        --height ${_MSDK_TFT_HEIGHT_}
                        --width ${_MSDK_TFT_WIDTH_}
                        --generator "LVGL"
                        --lvgl_version ${LVGL_VERSION}
                    DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/${file}
                    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/
                    COMMENT "Generating screen from ${CMAKE_CURRENT_SOURCE_DIR}/${file}."
                    VERBATIM
                )
            message(STATUS ${CMAKE_CURRENT_BINARY_DIR}/generated/${screen_relative_dir}/scr_${screen_no_ext}.h)
        endif()
    endforeach()

    ####GENERATE SCREENS.C i SCREENS.h
    list(APPEND designer_generated_sources ${CMAKE_CURRENT_BINARY_DIR}/generated/screens.c ${CMAKE_CURRENT_BINARY_DIR}/generated/screens.h)
    add_custom_command(
        OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/generated/screens.c ${CMAKE_CURRENT_BINARY_DIR}/generated/screens.h
        COMMAND ${SCREENGEN_PATH} screens
            --screens   "${screens_list}"
            --header   ${CMAKE_CURRENT_BINARY_DIR}/generated/screens.h
            --source   ${CMAKE_CURRENT_BINARY_DIR}/generated/screens.c
            --generator "LVGL"
            --lvgl_version ${LVGL_VERSION}
        DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/${file}
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/
        COMMENT "Generating screens helper file"
        VERBATIM
    )
    # Create a custom target for the generated sources
    set(custom_target_name "${_targetName}_generated")
    add_custom_target(${custom_target_name} DEPENDS ${designer_generated_sources})

    # Ensure that the main target depends on the custom target
    add_dependencies(${_targetName} ${custom_target_name})

    target_include_directories(${_targetName} PUBLIC ${CMAKE_CURRENT_BINARY_DIR}/generated)
    target_sources(${_targetName} PUBLIC ${designer_generated_sources})
endfunction()


include(GNUInstallDirs)
include(CMakePackageConfigHelpers)
include(mikroeUtilsCommon)