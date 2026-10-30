package spike;

import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

class Crud06Test extends CrudSuite {
    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) { register(r, "Crud06"); }
}
